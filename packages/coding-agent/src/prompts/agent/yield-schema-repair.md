Your accepted `yield` sections do not form a valid final result:

{{failure}}

Repair the result now. Call `yield` once with `type: "result"` and a `result.data` object containing every missing or invalid terminal field named above. Omit accepted incremental collection keys such as `findings`; they are merged into the repaired result automatically. Include a collection key only when the failure says that collection is missing or invalid, or when you intend to replace the accepted collection. If the prior `yield` call returned an error, its data was not recorded.
