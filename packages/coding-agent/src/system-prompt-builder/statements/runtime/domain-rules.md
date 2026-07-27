<domain-rules>
{{#each rules}}
- {{name}} ({{#list globs join=", "}}{{this}}{{/list}}): {{description}}
{{/each}}
</domain-rules>

