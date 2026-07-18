# frozen_string_literal: false
# Veyyon Ruby runner — subprocess wrapper used by the coding-agent host.
#
# Mirrors the Python runner (eval/py/runner.py): a persistent Ruby process that
# speaks NDJSON over stdin/stdout. The host writes one JSON request per line
# ({id, code, cwd?, env?, silent?}) and the runner replies with frames:
#   {type:"started", id}
#   {type:"stdout"|"stderr", id, data}
#   {type:"display"|"result", id, bundle}   # bundle = Jupyter-style MIME hash
#   {type:"error", id, ename, evalue, traceback:[...]}
#   {type:"done", id, status, executionCount, cancelled}
# A {type:"exit"} request (or stdin EOF) shuts the runner down.
#
# Each cell is evaluated in the persistent TOPLEVEL_BINDING so local variables,
# methods, and constants survive across cells. The last expression's value is
# auto-displayed (like IRB) unless it is nil, an assignment, or a definition.
#
# Frame channel isolation: the original stdout is dup'd onto a private IO for
# protocol frames, then fd 1/fd 2 are repointed at internal pipes. Child
# processes that inherit stdout/stderr land in those pipes and drain threads
# re-emit their bytes as stdout/stderr frames instead of corrupting the NDJSON
# channel. Ruby-level writes go through $stdout/$stderr proxies that emit frames
# synchronously so they order correctly with display output.

require "json"

# ---------------------------------------------------------------------------
# Frame channel + fd capture setup
# ---------------------------------------------------------------------------

$__veyyon_out_mutex = Mutex.new
$__veyyon_raw_stderr = (STDERR.dup rescue STDERR)
$__veyyon_current_rid = nil
$__veyyon_capture_rid = nil
$__veyyon_exec_count = 0
$__veyyon_active_exec = 0
$__veyyon_silent = false

begin
  $__veyyon_frame_io = STDOUT.dup
  $__veyyon_frame_io.sync = true
  __veyyon_stdout_cap_r, __veyyon_stdout_cap_w = IO.pipe
  STDOUT.reopen(__veyyon_stdout_cap_w)
  STDOUT.sync = true
  __veyyon_stdout_cap_w.close
  $__veyyon_stdout_capture_read = __veyyon_stdout_cap_r
rescue StandardError
  $__veyyon_frame_io = STDOUT
  ($__veyyon_frame_io.sync = true) rescue nil
  $__veyyon_stdout_capture_read = nil
end

begin
  __veyyon_stderr_cap_r, __veyyon_stderr_cap_w = IO.pipe
  STDERR.reopen(__veyyon_stderr_cap_w)
  STDERR.sync = true
  __veyyon_stderr_cap_w.close
  $__veyyon_stderr_capture_read = __veyyon_stderr_cap_r
rescue StandardError
  $__veyyon_stderr_capture_read = nil
end

# Protect the protocol channel from user code: read requests on a private dup of
# the original stdin, then repoint fd 0 at /dev/null so a user `gets`/`STDIN.gets`
# inside a cell sees EOF instead of consuming the next JSON request.
begin
  $__veyyon_proto_stdin = STDIN.dup
  STDIN.reopen(File.open(File::NULL, "r"))
rescue StandardError
  $__veyyon_proto_stdin = STDIN
end

# ---------------------------------------------------------------------------
# Frame writer + helpers (top-level private methods, available to user code)
# ---------------------------------------------------------------------------

def __veyyon_scrub(str)
  s = str.to_s
  begin
    s = s.encoding == Encoding::UTF_8 ? s : s.encode(Encoding::UTF_8, invalid: :replace, undef: :replace)
  rescue StandardError
    s = s.dup.force_encoding(Encoding::UTF_8)
  end
  s.valid_encoding? ? s : s.scrub("\uFFFD")
end

def __veyyon_emit(frame)
  line =
    begin
      JSON.generate(frame)
    rescue StandardError
      JSON.generate(
        "type" => (frame["type"] || "stdout"),
        "id" => frame["id"],
        "data" => "<unserializable frame>\n",
      )
    end
  $__veyyon_out_mutex.synchronize do
    $__veyyon_frame_io.write(line)
    $__veyyon_frame_io.write("\n")
    $__veyyon_frame_io.flush
  end
rescue StandardError
  nil
end

def __veyyon_run_id
  $__veyyon_current_rid
end

def __veyyon_emit_stream(kind, text)
  rid = $__veyyon_current_rid
  if rid.nil?
    ($__veyyon_raw_stderr.write(text) rescue nil)
    return
  end
  __veyyon_emit("type" => kind, "id" => rid, "data" => __veyyon_scrub(text))
end

def __veyyon_emit_display(bundle, kind = "display")
  rid = $__veyyon_current_rid
  return if rid.nil?
  __veyyon_emit("type" => kind, "id" => rid, "bundle" => bundle)
end

def __veyyon_emit_status(op, data = {})
  status = { "op" => op.to_s }
  data.each { |k, v| status[k.to_s] = v }
  __veyyon_emit_display({ "application/x-veyyon-status" => status }, "display")
end

VEYYON_IMAGE_MIMES = %w[image/png image/jpeg].freeze

# True when `str` already looks like base64 text (ASCII, base64 alphabet, length
# a multiple of 4). Raw image blobs (PNG/JPEG bytes) contain high bytes, so they
# fail the ASCII check and get encoded instead of passed through unchanged.
def __veyyon_base64?(str)
  s = str.to_s
  # ascii_only? is safe on any encoding (no regex over invalid bytes). Raw image
  # blobs carry high bytes and fail here, so they get encoded rather than scanned.
  return false unless s.ascii_only?
  stripped = s.gsub(/\s+/, "")
  return false if stripped.empty? || (stripped.bytesize % 4) != 0
  stripped.match?(%r{\A[A-Za-z0-9+/]*={0,2}\z})
end

# Coerce an image payload to the base64 ASCII the host renders. IRuby-style
# `to_iruby` hands back raw binary blobs (Gruff#to_blob, ChunkyPNG, RMagick),
# which would also break JSON.generate; strict-encode them unless already base64.
def __veyyon_image_payload(content)
  require "base64"
  s = content.to_s
  return s.gsub(/\s+/, "") if __veyyon_base64?(s)
  Base64.strict_encode64(s.b)
end

# Detect a host-renderable image MIME from a binary blob's magic bytes. Lets us
# treat the generic `to_blob` (Gruff/RMagick/ChunkyPNG/Vips) as an image only
# when it really is one, avoiding false positives on unrelated `to_blob` methods.
def __veyyon_sniff_image_mime(bytes)
  b = bytes.to_s.b
  return "image/png" if b.start_with?("\x89PNG\r\n\x1a\n".b)
  return "image/jpeg" if b.start_with?("\xFF\xD8\xFF".b)
  nil
end

# Stringify keys, base64-encode image payloads, and scrub text payloads so the
# bundle is always JSON-safe before it reaches __veyyon_emit.
def __veyyon_normalize_bundle(hash)
  bundle = {}
  hash.each do |key, val|
    k = key.to_s
    bundle[k] =
      if VEYYON_IMAGE_MIMES.include?(k)
        __veyyon_image_payload(val)
      elsif val.is_a?(String)
        __veyyon_scrub(val)
      else
        val
      end
  end
  bundle
end

# Guarantee a text/plain entry so the model always sees a textual hint, even for
# image-only bundles (mirrors the Python runner).
def __veyyon_finalize_bundle(bundle, value)
  bundle["text/plain"] ||= __veyyon_scrub((value.inspect rescue value.class.name))
  bundle
end

# Rich-display resolution for non-collection objects. Honors the repo
# `to_veyyon_mime` convention first (`to_omp_mime` accepted as the legacy
# pre-rebrand name), then the IRuby protocol
# (`to_iruby_mimebundle` -> [data, metadata], `to_iruby` -> [mime, data]) so plot
# and image objects (gruff, rubyplot, gnuplotrb, chunky_png, daru, ...) render
# inline — the Ruby analog of IPython's _repr_*_ methods. Returns nil when the
# value advertises no rich representation.
def __veyyon_rich_mime_bundle(value)
  mime_method = %i[to_veyyon_mime to_omp_mime].find { |m| value.respond_to?(m) }
  if mime_method
    mime = (value.public_send(mime_method) rescue nil)
    return __veyyon_finalize_bundle(__veyyon_normalize_bundle(mime), value) if mime.is_a?(Hash) && !mime.empty?
  end
  if value.respond_to?(:to_iruby_mimebundle)
    data =
      begin
        value.to_iruby_mimebundle
      rescue ArgumentError
        (value.to_iruby_mimebundle(include: []) rescue nil)
      rescue StandardError
        nil
      end
    data = data.first if data.is_a?(Array)
    return __veyyon_finalize_bundle(__veyyon_normalize_bundle(data), value) if data.is_a?(Hash) && !data.empty?
  end
  if value.respond_to?(:to_iruby)
    pair = (value.to_iruby rescue nil)
    if pair.is_a?(Array) && pair.size == 2 && !pair[0].nil?
      return __veyyon_finalize_bundle(__veyyon_normalize_bundle({ pair[0].to_s => pair[1] }), value)
    end
  end
  # Last resort: probe well-known image emitters. Named methods (to_png/to_jpeg)
  # are trusted; the generic to_blob is accepted only when its bytes sniff as an
  # image. Covers gems that render via IRuby's registry rather than to_iruby
  # (Gruff#to_blob, ChunkyPNG#to_blob, RMagick, Vips, ...).
  if value.respond_to?(:to_png)
    png = (value.to_png rescue nil)
    return __veyyon_finalize_bundle({ "image/png" => __veyyon_image_payload(png) }, value) if png
  end
  jpeg_method = %i[to_jpeg to_jpg].find { |m| value.respond_to?(m) }
  if jpeg_method
    jpg = (value.public_send(jpeg_method) rescue nil)
    return __veyyon_finalize_bundle({ "image/jpeg" => __veyyon_image_payload(jpg) }, value) if jpg
  end
  if value.respond_to?(:to_blob)
    blob = (value.to_blob rescue nil)
    if blob.is_a?(String) && (mime = __veyyon_sniff_image_mime(blob))
      return __veyyon_finalize_bundle({ mime => __veyyon_image_payload(blob) }, value)
    end
  end

  nil
end

# Build a Jupyter-style MIME bundle for a value. Strings render as plain text,
# Hash/Array render as JSON (plus a text/plain repr) so the model sees structure.
# Other objects may expose a rich representation via `to_veyyon_mime` or the IRuby
# protocol (`to_iruby`/`to_iruby_mimebundle`); otherwise they fall back to inspect.
def __veyyon_mime_bundle(value)
  case value
  when String
    { "text/plain" => __veyyon_scrub(value) }
  when Hash, Array
    safe = begin
      JSON.parse(JSON.generate(value))
    rescue StandardError
      nil
    end
    if safe.nil?
      { "text/plain" => __veyyon_scrub(value.inspect) }
    else
      { "application/json" => safe, "text/plain" => __veyyon_scrub(value.inspect) }
    end
  when nil
    { "text/plain" => "nil" }
  else
    __veyyon_rich_mime_bundle(value) || { "text/plain" => __veyyon_scrub(value.inspect) }
  end
end

def __veyyon_present(value, kind = "display")
  __veyyon_emit_display(__veyyon_mime_bundle(value), kind)
end

# ---------------------------------------------------------------------------
# User stdout/stderr proxies — emit typed frames for the current request.
# ---------------------------------------------------------------------------

class VeyyonStreamProxy
  def initialize(kind, io, fileno)
    @kind = kind
    @io = io
    @fileno = fileno
  end

  def write(*args)
    total = 0
    args.each do |arg|
      s = arg.to_s
      next if s.empty?
      total += s.bytesize
      __veyyon_emit_stream(@kind, s)
    end
    total
  end

  def print(*args)
    args.each { |a| write(a) }
    nil
  end

  def <<(obj)
    write(obj)
    self
  end

  def puts(*args)
    if args.empty?
      write("\n")
    else
      args.each do |arg|
        if arg.is_a?(Array)
          arg.empty? ? write("\n") : puts(*arg)
        else
          s = arg.to_s
          write(s.end_with?("\n") ? s : "#{s}\n")
        end
      end
    end
    nil
  end

  def printf(fmt, *args)
    write(format(fmt, *args))
    nil
  end

  def write_nonblock(s, *)
    write(s)
  end

  def flush; self; end
  def sync; true; end
  def sync=(value); value; end
  def tty?; false; end
  def isatty; false; end
  def fileno; @fileno; end
  def to_io; @io; end
  def closed?; false; end
  def fsync; 0; end
  def external_encoding
    (@io.external_encoding rescue Encoding::UTF_8)
  end
end

# ---------------------------------------------------------------------------
# fd-1/fd-2 capture drains (child-process stdout/stderr) + parent watchdog
# ---------------------------------------------------------------------------

def __veyyon_start_capture_drain(io, kind)
  return if io.nil?
  Thread.new do
    loop do
      chunk =
        begin
          io.readpartial(65_536)
        rescue EOFError, IOError, Errno::EBADF
          break
        rescue StandardError
          break
        end
      next if chunk.nil? || chunk.empty?
      rid = $__veyyon_capture_rid
      if rid.nil?
        ($__veyyon_raw_stderr.write(chunk) rescue nil)
      else
        __veyyon_emit("type" => kind, "id" => rid, "data" => __veyyon_scrub(chunk))
      end
    end
  end
end

def __veyyon_start_parent_watchdog
  return unless RUBY_PLATFORM !~ /mswin|mingw|cygwin/
  return unless Process.respond_to?(:ppid)
  original = (Process.ppid rescue 0)
  return if original <= 1
  Thread.new do
    loop do
      begin
        Process.exit!(0) if Process.ppid != original
      rescue StandardError
        break
      end
      sleep 10
    end
  end
end

# ---------------------------------------------------------------------------
# Signal handling — SIGINT raises Interrupt only while a cell is executing.
# ---------------------------------------------------------------------------

def __veyyon_install_idle_sigint
  Signal.trap("INT", "IGNORE") rescue nil
end

def __veyyon_install_exec_sigint
  Signal.trap("INT", "DEFAULT") rescue nil
end

def __veyyon_begin_exec
  $__veyyon_active_exec += 1
  __veyyon_install_exec_sigint
end

def __veyyon_end_exec
  $__veyyon_active_exec -= 1 if $__veyyon_active_exec > 0
  __veyyon_install_idle_sigint if $__veyyon_active_exec.zero?
end

# ---------------------------------------------------------------------------
# Per-request runtime (cwd + managed env) + auto-result suppression
# ---------------------------------------------------------------------------

VEYYON_MANAGED_ENV_KEYS = %w[
  VEYYON_SESSION_FILE
  VEYYON_ARTIFACTS_DIR
  VEYYON_TOOL_BRIDGE_URL
  VEYYON_TOOL_BRIDGE_TOKEN
  VEYYON_TOOL_BRIDGE_SESSION
  VEYYON_EVAL_LOCAL_ROOTS
].freeze

def __veyyon_apply_request_runtime(req)
  cwd = req["cwd"]
  if cwd.is_a?(String) && !cwd.empty?
    (Dir.chdir(cwd) rescue nil)
    $LOAD_PATH.delete(cwd)
    $LOAD_PATH.unshift(cwd)
  end
  env = req["env"]
  if env.is_a?(Hash)
    VEYYON_MANAGED_ENV_KEYS.each do |key|
      next unless env.key?(key)
      value = env[key]
      if value.is_a?(String)
        ENV[key] = value
      elsif value.nil?
        ENV.delete(key)
      end
    end
  end
end

# Last value-bearing AST node types we should NOT auto-display (statements /
# definitions, mirroring IPython's "only display a trailing expression"). Falls
# back to displaying any non-nil value when the AST is unavailable.
VEYYON_NON_DISPLAY_NODES = %i[
  LASGN IASGN GASGN CVASGN DASGN OP_ASGN OP_CDECL CDECL MASGN CASGN
  DEFN DEFS CLASS MODULE SCLASS ALIAS UNDEF
].freeze

def __veyyon_ast_last(node)
  return nil unless node.is_a?(RubyVM::AbstractSyntaxTree::Node)
  case node.type
  when :SCOPE
    __veyyon_ast_last(node.children[2])
  when :BLOCK
    kids = node.children.compact
    kids.empty? ? nil : __veyyon_ast_last(kids.last)
  else
    node
  end
end

def __veyyon_should_display_result?(src)
  return true unless defined?(RubyVM::AbstractSyntaxTree)
  node =
    begin
      RubyVM::AbstractSyntaxTree.parse(src)
    rescue StandardError, SyntaxError
      return true
    end
  last = __veyyon_ast_last(node)
  return true if last.nil?
  !VEYYON_NON_DISPLAY_NODES.include?(last.type)
end

# ---------------------------------------------------------------------------
# Request dispatch
# ---------------------------------------------------------------------------

def __veyyon_emit_error(rid, exc, name_override = nil)
  ename = name_override || exc.class.name
  evalue = (exc.message.to_s rescue "")
  backtrace = (exc.backtrace || [])
  user_tb = backtrace.select { |l| l.include?("(eval)") }
  user_tb = backtrace.first(20) if user_tb.empty?
  traceback = ["#{ename}: #{evalue}"]
  user_tb.each { |line| traceback << "  #{line}" }
  __veyyon_emit(
    "type" => "error",
    "id" => rid,
    "ename" => ename,
    "evalue" => __veyyon_scrub(evalue),
    "traceback" => traceback.map { |l| __veyyon_scrub(l) },
  )
end

def __veyyon_handle_request(req)
  rid = req["id"].to_s
  $__veyyon_current_rid = rid
  $__veyyon_capture_rid = rid
  $__veyyon_silent = req["silent"] == true
  $__veyyon_exec_count += 1
  count = $__veyyon_exec_count
  __veyyon_emit("type" => "started", "id" => rid)

  status = "ok"
  cancelled = false
  begin
    begin
      __veyyon_apply_request_runtime(req)
      src = req["code"].to_s
    rescue Exception => e # rubocop:disable Lint/RescueException
      __veyyon_emit_error(rid, e)
      __veyyon_emit("type" => "done", "id" => rid, "status" => "error", "executionCount" => count, "cancelled" => false)
      return
    end

    __veyyon_begin_exec
    begin
      value = TOPLEVEL_BINDING.eval(src, "(eval)")
      unless $__veyyon_silent || value.nil? || !__veyyon_should_display_result?(src)
        __veyyon_present(value, "result")
      end
    rescue Interrupt => e
      cancelled = true
      status = "error"
      __veyyon_emit_error(rid, e, "Interrupt")
    rescue SystemExit => e
      status = "error"
      __veyyon_emit_error(rid, e)
    rescue Exception => e # rubocop:disable Lint/RescueException
      status = "error"
      __veyyon_emit_error(rid, e)
    ensure
      __veyyon_end_exec
    end

    __veyyon_emit("type" => "done", "id" => rid, "status" => status, "executionCount" => count, "cancelled" => cancelled)
  ensure
    $__veyyon_capture_rid = nil if $__veyyon_capture_rid == rid
    $__veyyon_current_rid = nil
  end
end

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def __veyyon_main
  $stdout = VeyyonStreamProxy.new("stdout", STDOUT, 1)
  $stderr = VeyyonStreamProxy.new("stderr", STDERR, 2)
  __veyyon_install_idle_sigint
  __veyyon_start_parent_watchdog
  __veyyon_start_capture_drain($__veyyon_stdout_capture_read, "stdout")
  __veyyon_start_capture_drain($__veyyon_stderr_capture_read, "stderr")

  $__veyyon_proto_stdin.each_line do |raw|
    line = raw.strip
    next if line.empty?
    req =
      begin
        JSON.parse(line)
      rescue JSON::ParserError => e
        __veyyon_emit(
          "type" => "error",
          "id" => "",
          "ename" => "ProtocolError",
          "evalue" => "Invalid JSON request: #{e.message}",
          "traceback" => [],
        )
        next
      end
    break if req.is_a?(Hash) && req["type"] == "exit"
    __veyyon_handle_request(req) if req.is_a?(Hash)
  end
end

__veyyon_main
