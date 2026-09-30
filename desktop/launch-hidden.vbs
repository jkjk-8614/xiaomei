Option Explicit

Dim shell, fso, root, shellApp, electronExe, message
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
electronExe = root & "\desktop\node_modules\electron\dist\electron.exe"

If fso.FileExists(electronExe) Then
  shell.Environment("Process")("XIAOMEI_CANVAS_DATA_ROOT") = root
  shell.Environment("Process")("XIAOMEI_CANVAS_PORT") = "3300"
  shell.Environment("Process")("COMMERCE_ANALYSIS_BROWSER_PORT") = "9327"
  shell.Environment("Process")("TEMP") = root & "\user_data\tmp"
  shell.Environment("Process")("TMP") = root & "\user_data\tmp"
  Set shellApp = CreateObject("Shell.Application")
  shellApp.ShellExecute electronExe, ".", root & "\desktop", "open", 1
  WScript.Quit 0
Else
  message = "Xiaomei Canvas desktop runtime was not found." & vbCrLf
  message = message & "Run this command in the project folder:" & vbCrLf
  message = message & "npm install --prefix desktop" & vbCrLf
  message = message & "Then double-click run.bat."
  MsgBox message, 48, "Xiaomei Canvas"
  WScript.Quit 1
End If
