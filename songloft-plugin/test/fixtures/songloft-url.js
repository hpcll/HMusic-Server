// Songloft URL polyfill 摘录（2026-09-14 审查快照）。保留上游实现，
// 特别是 hostname/port 的 split(':')，用于复现与标准 URL 的行为差异。
// 来源：https://github.com/songloft-org/songloft/blob/main/internal/jsruntime/polyfill.go
// 本夹具只替换 URL；测试中未使用的 searchParams 采用 Node URLSearchParams。
globalThis.URL = function(url, base) {
    if (base) {
        if (url.charAt(0)==='/') url = base.replace(/\/[^\/]*$/, '') + url;
        else if (!/^(https?|wss?):\/\//.test(url)) url = base + '/' + url;
    }
    if (!/^(https?|wss?):\/\//.test(url)) {
        throw new TypeError("Invalid URL: '" + url + "'");
    }
    var m = url.match(/^(https?:|wss?:)\/\/([^\/\?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/);
    this.href = url;
    this.protocol = m ? m[1] : '';
    this.host = m ? m[2] : '';
    this.hostname = this.host.split(':')[0];
    this.port = this.host.split(':')[1] || '';
    this.pathname = m && m[3] ? m[3] : '/';
    this.search = m && m[4] ? m[4] : '';
    this.hash = m && m[5] ? m[5] : '';
    this.searchParams = new URLSearchParams(this.search);
    this.origin = this.protocol + '//' + this.host;
};
globalThis.URL.prototype.toString = function() { return this.href; };
