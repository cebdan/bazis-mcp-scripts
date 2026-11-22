// Bazis capability probe.
// Run once via "Скрипты" in Bazis 2022 and send the resulting report back.
// Checks what the script engine offers for the MCP bridge: API version,
// Node-like modules, timers, HTTP via COM, external process launch.

var lines = [];
function out(name, value) { lines.push(name + ": " + value); }
function check(name, fn) {
    try { out(name, fn()); } catch (e) { out(name, "ERROR " + e); }
}

check("apiVersion", function () { return system.apiVersion; });
check("developerApiVersion", function () { return system.developerApiVersion; });

// Globals that would make a background loop / network channel possible.
check("typeof require", function () { return typeof require; });
check("typeof fs", function () { return typeof fs; });
check("typeof setTimeout", function () { return typeof setTimeout; });
check("typeof setInterval", function () { return typeof setInterval; });
check("typeof XMLHttpRequest", function () { return typeof XMLHttpRequest; });
check("typeof Promise", function () { return typeof Promise; });
check("typeof NewCOMObject", function () { return typeof NewCOMObject; });
check("typeof Action.Continue", function () { return typeof Action.Continue; });
check("typeof system.exec", function () { return typeof system.exec; });
check("typeof system.sleep", function () { return typeof system.sleep; });

// Node-style modules, if require exists.
check("require('fs')", function () { return typeof require("fs"); });
check("require('http')", function () { return typeof require("http"); });
check("require('net')", function () { return typeof require("net"); });
check("require('child_process')", function () { return typeof require("child_process"); });

// HTTP through Windows COM (WinHTTP / MSXML).
check("COM WinHttp.WinHttpRequest.5.1", function () {
    return typeof NewCOMObject("WinHttp.WinHttpRequest.5.1");
});
check("COM MSXML2.ServerXMLHTTP.6.0", function () {
    return typeof NewCOMObject("MSXML2.ServerXMLHTTP.6.0");
});

// Model access.
check("Model.Count", function () { return Model.Count; });
check("Article.Name", function () { return Article.Name; });

var report = lines.join("\n");
system.log(report);
alert(report);
var path = system.askFileNameSave("txt");
if (path) system.writeTextFile(path, report);
