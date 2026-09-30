Option Explicit

Dim shell, fso, root, shellApp, brandedExe, electronExe, message
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
brandedExe = root & "\desktop\node_modules\electron\dist\" & ChrW(&H5C0F) & ChrW(&H7F8E) & ChrW(&H753B) & ChrW(&H5E03) & ".exe"
electronExe = root & "\desktop\node_modules\electron\dist\electron.exe"

If fso.FileExists(brandedExe) Then
  shell.Environment("Process")("XIAOMEI_CANVAS_PORT") = "3000"
  Set shellApp = CreateObject("Shell.Application")
  shellApp.ShellExecute brandedExe, ".", root & "\desktop", "open", 1
  WScript.Quit 0
ElseIf fso.FileExists(electronExe) Then
  shell.Environment("Process")("XIAOMEI_CANVAS_PORT") = "3000"
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
