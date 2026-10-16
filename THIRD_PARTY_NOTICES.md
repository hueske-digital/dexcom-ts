# Third-party notices

The published package contains code generated with [Kubb](https://kubb.dev). The runtime files under `dist/generated/.kubb/` are copied from `@kubb/plugin-fetch` and are licensed as follows:

```
MIT License

Copyright (c) 2026 Kubb Labs

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

## Not included

- The Dexcom API v3 OpenAPI document is not part of this repository or package. The build downloads it from developer.dexcom.com, checks its pinned SHA-256 and generates code from its structure only; descriptions, summaries and examples are removed before generation.
- The Dexcom Share client is written for this project. Its protocol details (hosts, endpoints, application IDs, error codes) follow the documentation and behaviour of [pydexcom](https://github.com/gagebenne/pydexcom) (MIT); no pydexcom code is included.
