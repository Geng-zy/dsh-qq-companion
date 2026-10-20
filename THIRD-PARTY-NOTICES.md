# 第三方声明

## dsh-onebot（BSD-3-Clause）

本插件由 [mario841859784/dsh-onebot](https://github.com/mario841859784/dsh-onebot) v0.9.3 修改而来，原作者的版权声明和许可条款见 [LICENSE](LICENSE)。

## dsh-qq-onebot-bridge（MIT）

以下设计参考了 dsh-qq-onebot-bridge（MIT License），实现为本项目自行编写：

- `src/trace.ts`：短的可排序 traceId 形态（`t-<base36 秒>-<计数>`）、4MiB 文件上限、同一原因 5 分钟只记一次、序列化防护（jsonlSafe 思路）、“静默丢弃也要留下 ok=false 和原因”的原则。
- `src/health.ts`：“健康快照 + 脱敏诊断包”的思路。
- 默认值：入站去重窗口 300 秒（`dedupWindowSeconds`）、主动写每分钟 20 次 / 每天 500 次（`actionRatePerMinute` / `actionRatePerDay`）。

```
MIT License

Copyright (c) 2026 dsh-qq-onebot-bridge contributors

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
