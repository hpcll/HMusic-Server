# 第三方声明

HMusic Server 还使用 `package.json` 中列出的开源依赖。发布构建应保留生产依赖的名称、版本和许可证
清单，并按各依赖的 LICENSE/NOTICE 履行义务。

HMusic 不随仓库提供第三方音乐内容、平台账号或服务端密钥。部署者只能接入自己拥有合法使用权的音频、
封面、歌词和音源服务，并自行遵守上游平台条款。

## Vue 3

`web/vendor/vue.esm-browser.prod.js` 来自 [Vue](https://github.com/vuejs/core) 3.5.39，
采用 MIT License，版权归 Yuxi (Evan) You 及 Vue 贡献者所有。该文件保留了上游许可证头部。

## qrcode-generator

`web/vendor/qrcode.js` 来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)，
采用 MIT License，版权归 Kazuhiko Arase 所有。该文件保留了上游许可证声明。

## SongLoft / songloft-plugin-miot

本项目的小爱音箱兼容层中，部分机型映射、播放 API 分流、TTS 命令选择、MiIO/MIoT
请求和登录流程参考并以 TypeScript 重新实现了
[SongLoft](https://github.com/songloft-org/songloft) 的
[songloft-plugin-miot](https://github.com/songloft-org/songloft-plugin-miot) 公开实现。
这些实现经过 HMusic 的认证、队列、代理和服务端架构改造，不是对 SongLoft 仓库的整体复制。

上游插件声明使用 Apache-2.0，版权归涵曦及其贡献者所有。HMusic 保留本仓库的
[Apache License 2.0](LICENSE)，并在此注明上游项目和修改后的分发范围。

## xiaomusic

本项目的小爱音箱播放与 TTS 兼容逻辑还参考了
[xiaomusic](https://github.com/hanxi/xiaomusic) 的公开实现，包括部分机型适配、播放命令选择
和小米设备接口调用方式。SongLoft MIoT 插件的公开源码也明确注明其 TTS 命令映射沿用了
xiaomusic 的对应约定。

上游项目使用 MIT License：

```text
MIT License

Copyright (c) 2023 涵曦

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
