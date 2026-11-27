' Supervising silent launcher for TopSolid MCP Bridge (zero console window flash)
' Keeps ts6_bridge.ps1 alive on crashes/taskkill with exponential backoff (5s..300s),
' respects manual Exit via stopped.flag, and handles clean restart (exit 10).
Option Explicit

Dim fso, sh, agentDir, ps1Path, appDataDir, logPath, stoppedFlagPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

agentDir        = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path         = fso.BuildPath(agentDir, "ts6_bridge.ps1")
appDataDir      = fso.BuildPath(sh.ExpandEnvironmentStrings("%APPDATA%"), "TopSolid6MCP")
logPath         = fso.BuildPath(appDataDir, "bridge.log")
stoppedFlagPath = fso.BuildPath(appDataDir, "stopped.flag")

If Not fso.FolderExists(appDataDir) Then
    On Error Resume Next
    fso.CreateFolder appDataDir
    On Error GoTo 0
End If

' Parse arguments: --clear-stop clears manual stop flag (used by Start Menu / .bat)
Dim extraArgs, i, arg, clearStop
extraArgs = ""
clearStop = False
For i = 0 To WScript.Arguments.Count - 1
    arg = WScript.Arguments.Item(i)
    If LCase(arg) = "--clear-stop" Then
        clearStop = True
    Else
        If InStr(arg, " ") > 0 Then
            extraArgs = extraArgs & " """ & arg & """"
        Else
            extraArgs = extraArgs & " " & arg
        End If
    End If
Next

If clearStop And fso.FileExists(stoppedFlagPath) Then
    On Error Resume Next
    fso.DeleteFile stoppedFlagPath, True
    On Error GoTo 0
End If

Sub WriteLog(msg)
    On Error Resume Next
    Dim ts, h, m, s, f
    h = Right("0" & Hour(Now), 2)
    m = Right("0" & Minute(Now), 2)
    s = Right("0" & Second(Now), 2)
    ts = h & ":" & m & ":" & s
    Set f = fso.OpenTextFile(logPath, 8, True)
    f.WriteLine "[" & ts & "] [INFO] [LAUNCHER] " & msg
    f.Close
    On Error GoTo 0
End Sub

Function GetCurrentLogonTime()
    On Error Resume Next
    GetCurrentLogonTime = DateAdd("yyyy", -10, Now)
    Dim wmi, procs, proc, ownerUser, ownerDom, curUser, dt, bestDt, hasBest, osList, osItem
    curUser = LCase(sh.ExpandEnvironmentStrings("%USERNAME%"))
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    Set procs = wmi.ExecQuery("SELECT CreationDate, ProcessId FROM Win32_Process WHERE Name='explorer.exe'")
    hasBest = False
    For Each proc In procs
        ownerUser = ""
        ownerDom = ""
        Err.Clear
        proc.GetOwner ownerUser, ownerDom
        If Err.Number <> 0 Or ownerUser = "" Or LCase(ownerUser) = curUser Then
            If Not IsNull(proc.CreationDate) Then
                Set dt = CreateObject("WbemScripting.SWbemDateTime")
                dt.Value = proc.CreationDate
                If Not hasBest Or dt.GetVarDate(True) > bestDt Then
                    bestDt = dt.GetVarDate(True)
                    hasBest = True
                End If
            End If
        End If
    Next
    If Not hasBest Then
        Set osList = wmi.ExecQuery("SELECT LastBootUpTime FROM Win32_OperatingSystem")
        For Each osItem In osList
            If Not IsNull(osItem.LastBootUpTime) Then
                Set dt = CreateObject("WbemScripting.SWbemDateTime")
                dt.Value = osItem.LastBootUpTime
                bestDt = dt.GetVarDate(True)
                hasBest = True
            End If
        Next
    End If
    If hasBest Then GetCurrentLogonTime = bestDt
    On Error GoTo 0
End Function

Function ShouldRespectStoppedFlag()
    ShouldRespectStoppedFlag = False
    If Not fso.FileExists(stoppedFlagPath) Then Exit Function
    On Error Resume Next
    Dim fl, flagTime, logonTime
    Set fl = fso.GetFile(stoppedFlagPath)
    flagTime = fl.DateLastModified
    logonTime = GetCurrentLogonTime()
    If flagTime >= logonTime Then
        ShouldRespectStoppedFlag = True
    Else
        ' Flag is from a previous logon session -> delete and start normally
        fso.DeleteFile stoppedFlagPath, True
    End If
    On Error GoTo 0
End Function

' Mark environment so ts6_bridge.ps1 knows it is supervised by this launcher
sh.Environment("PROCESS")("TS6_LAUNCHER") = "1"

Dim backoffSec, baseCmd, cmd, runArgs, tStart, elapsedSec, code
backoffSec = 5
baseCmd = "powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -STA -File """ & ps1Path & """"
runArgs = extraArgs

Do
    If ShouldRespectStoppedFlag() Then
        WScript.Quit 0
    End If

    cmd = baseCmd & runArgs
    runArgs = "" ' Only pass one-shot UI flags (-OpenInfo/-OpenSettings) on the first iteration
    tStart = Now
    code = sh.Run(cmd, 0, True)
    elapsedSec = DateDiff("s", tStart, Now)

    If code = 0 Then
        ' Clean Exit from tray menu
        WScript.Quit 0
    ElseIf code = 3 Then
        ' Another bridge instance already holds the mutex
        WScript.Quit 0
    ElseIf code = 10 Then
        ' Bridge requested clean restart (Tray -> Restart or GitHub update)
        WriteLog "bridge exited code=10 (restart requested), restarting immediately"
        backoffSec = 5
    Else
        ' Crash / taskkill / unexpected exit
        If elapsedSec >= 600 Then
            backoffSec = 5
        End If
        WriteLog "bridge exited code=" & code & ", restart in " & backoffSec & "s"
        WScript.Sleep backoffSec * 1000
        backoffSec = backoffSec * 2
        If backoffSec > 300 Then backoffSec = 300
    End If
Loop
