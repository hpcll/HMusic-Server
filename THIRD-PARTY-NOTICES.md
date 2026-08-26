# 第三方声明

HMusic Server 还使用 `package.json` 中列出的开源依赖。发布构建应保留生产依赖的名称、版本和许可证
清单，并按各依赖的 LICENSE/NOTICE 履行义务。

HMusic 不随仓库提供第三方音乐内容、平台账号或服务端密钥。部署者只能接入自己拥有合法使用权的音频、
封面、歌词和音源服务，并自行遵守上游平台条款。

## xiaomusic

本项目的小爱音箱播放与 TTS 兼容逻辑参考了 [xiaomusic](https://github.com/hanxi/xiaomusic)
的公开实现，包括部分机型适配、播放命令选择和小米设备接口调用方式。

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
