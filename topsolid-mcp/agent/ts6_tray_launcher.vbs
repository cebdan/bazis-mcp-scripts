' Silent launcher for TopSolid MCP Bridge (zero console window flash)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

agentDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path  = fso.BuildPath(agentDir, "ts6_bridge.ps1")

extraArgs = ""
For i = 0 To WScript.Arguments.Count - 1
    arg = WScript.Arguments.Item(i)
    If InStr(arg, " ") > 0 Then
        extraArgs = extraArgs & " """ & arg & """"
    Else
        extraArgs = extraArgs & " " & arg
    End If
Next

cmd = "powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -STA -File """ & ps1Path & """" & extraArgs
sh.Run cmd, 0, False
