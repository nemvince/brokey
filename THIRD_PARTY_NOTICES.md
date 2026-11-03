# Third-party notices

Brokey is MIT-licensed. The files listed under "Derived material" contain code
ported from the projects below; their MIT notices are reproduced here.

## azrinaldi/opencode-free-bridge

Source: <https://github.com/azrinaldi/opencode-free-bridge>

```
MIT License

Copyright (c) 2026 azrinaldi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## opencode

Source: <https://github.com/anomalyco/opencode>

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Derived material

- `scripts/egress-proxy.ts` — HTTP forward proxy, ported from
  `azrinaldi/opencode-free-bridge`'s `egress-proxy.js`.
- `src/server/proxy/opencode/tools.ts` — the `read`/`shell` tool definitions and
  the tool-merge rules, ported from the same project's `identity.js` and
  `server.js`; the definitions themselves reproduce `anomalyco/opencode`'s own
  tool schemas.
- `src/server/proxy/opencode/identity.ts` — the session-id recipe, header set,
  and release-sync regexes, ported from `azrinaldi/opencode-free-bridge`'s
  `identity.js`, which reads `anomalyco/opencode`'s sources.
- `src/server/proxy/opencode/budget.ts` — the reasoning-aware output-token
  formula, ported from the same project's `token-budget.js`.
