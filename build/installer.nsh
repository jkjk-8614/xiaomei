!ifndef XIAOMEI_INSTALLER_NSH
!define XIAOMEI_INSTALLER_NSH

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; Older releases kept the user database inside the installation directory.
; electron-builder's uninstaller deletes the whole installation directory
; during an in-place update, so the data has to be moved out before the old
; uninstaller runs.  The new application imports the preserved copy into
; %LOCALAPPDATA%\小美画布 on first start.
Var /GLOBAL XiaomeiPreserveRoot
Var /GLOBAL XiaomeiPreservedAnything
Var /GLOBAL XiaomeiLegacyInstallDir
Var /GLOBAL XiaomeiInstallCompleted
Var /GLOBAL XiaomeiDiagnosticPath
Var /GLOBAL XiaomeiFailureStage

; Move $R0 to $R1.  Sets $R9=1 when a move fails and
; XiaomeiPreservedAnything=1 when at least one path was moved.
Function XiaomeiMovePath
  ${IfNot} ${FileExists} "$R0"
    Return
  ${EndIf}
  ; The desktop updater starts the installer immediately after asking the app
  ; to quit.  The Python backend may still hold a canvas or log file for a
  ; moment, so retry a sharing violation instead of aborting the update.
  StrCpy $R2 "0"
  xiaomei_move_retry:
    ClearErrors
    Rename "$R0" "$R1"
    ${IfNot} ${Errors}
      StrCpy $XiaomeiPreservedAnything "1"
      Return
    ${EndIf}
    IntOp $R2 $R2 + 1
    IntCmp $R2 10 xiaomei_move_failed 0 xiaomei_move_wait
    xiaomei_move_wait:
      Sleep 500
      Goto xiaomei_move_retry
  xiaomei_move_failed:
    StrCpy $XiaomeiFailureStage "preserve move: $R0"
    StrCpy $R9 "1"
FunctionEnd

; Best-effort rollback used when the old uninstaller cannot run.  Without it
; a failed install would leave the old program without its data directory.
Function XiaomeiRestoreLegacyData
  Push $R0
  Push $R1

  CreateDirectory "$XiaomeiLegacyInstallDir\resources\app\ComfyUI"
  CreateDirectory "$XiaomeiLegacyInstallDir\resources\app"
  CreateDirectory "$XiaomeiLegacyInstallDir"

  StrCpy $R0 "$XiaomeiPreserveRoot\app\data"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\resources\app\data"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\app\assets"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\resources\app\assets"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\app\output"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\resources\app\output"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\app\history.json"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\resources\app\history.json"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\app\global_config.json"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\resources\app\global_config.json"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\app\API"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\resources\app\API"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\app\.xiaomei-data"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\resources\app\.xiaomei-data"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\app\ComfyUI\workflows"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\resources\app\ComfyUI\workflows"
  Call XiaomeiRestorePath

  StrCpy $R0 "$XiaomeiPreserveRoot\root\data"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\data"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\root\assets"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\assets"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\root\output"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\output"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\root\history.json"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\history.json"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\root\global_config.json"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\global_config.json"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\root\API"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\API"
  Call XiaomeiRestorePath
  StrCpy $R0 "$XiaomeiPreserveRoot\root\.xiaomei-data"
  StrCpy $R1 "$XiaomeiLegacyInstallDir\.xiaomei-data"
  Call XiaomeiRestorePath

  Pop $R1
  Pop $R0
FunctionEnd

Function XiaomeiRestorePath
  ${IfNot} ${FileExists} "$R0"
    Return
  ${EndIf}
  ${If} ${FileExists} "$R1"
    Return
  ${EndIf}
  Rename "$R0" "$R1"
FunctionEnd

Function XiaomeiPreserveLegacyData
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  StrCpy $R9 "0"
  StrCpy $XiaomeiPreservedAnything "0"
  StrCpy $XiaomeiInstallCompleted "0"

  ; A timestamp plus the tick count avoids colliding with an earlier failed
  ; attempt that left its preservation directory behind.
  ${GetTime} "" "L" $R0 $R1 $R2 $R3 $R4 $R5 $R6
  StrCpy $R3 "$R2$R1$R0$R4$R5$R6"
  System::Call 'kernel32::GetTickCount() i .r7'
  ${If} $R7 == ""
    StrCpy $R7 "0"
  ${EndIf}
  ; Pick a fresh directory even when two updates start in the same second.
  StrCpy $R8 "0"
  xiaomei_preserve_root_retry:
    StrCpy $XiaomeiPreserveRoot "$XiaomeiLegacyInstallDir\..\xiaomei-legacy-data-$R3-$R7-$R8"
    IfFileExists "$XiaomeiPreserveRoot" 0 xiaomei_preserve_root_ready
    IntOp $R8 $R8 + 1
    Goto xiaomei_preserve_root_retry
  xiaomei_preserve_root_ready:
  CreateDirectory "$XiaomeiPreserveRoot"
  CreateDirectory "$XiaomeiPreserveRoot\app"
  CreateDirectory "$XiaomeiPreserveRoot\app\ComfyUI"
  CreateDirectory "$XiaomeiPreserveRoot\root"

  ; Normal packaged layout: <install>\resources\app\data
  StrCpy $R0 "$XiaomeiLegacyInstallDir\resources\app\data"
  StrCpy $R1 "$XiaomeiPreserveRoot\app\data"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\resources\app\assets"
  StrCpy $R1 "$XiaomeiPreserveRoot\app\assets"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\resources\app\output"
  StrCpy $R1 "$XiaomeiPreserveRoot\app\output"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\resources\app\history.json"
  StrCpy $R1 "$XiaomeiPreserveRoot\app\history.json"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\resources\app\global_config.json"
  StrCpy $R1 "$XiaomeiPreserveRoot\app\global_config.json"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\resources\app\API"
  StrCpy $R1 "$XiaomeiPreserveRoot\app\API"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\resources\app\.xiaomei-data"
  StrCpy $R1 "$XiaomeiPreserveRoot\app\.xiaomei-data"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\resources\app\ComfyUI\workflows"
  StrCpy $R1 "$XiaomeiPreserveRoot\app\ComfyUI\workflows"
  Call XiaomeiMovePath

  ; Very old portable layout: data beside the executable.
  StrCpy $R0 "$XiaomeiLegacyInstallDir\data"
  StrCpy $R1 "$XiaomeiPreserveRoot\root\data"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\assets"
  StrCpy $R1 "$XiaomeiPreserveRoot\root\assets"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\output"
  StrCpy $R1 "$XiaomeiPreserveRoot\root\output"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\history.json"
  StrCpy $R1 "$XiaomeiPreserveRoot\root\history.json"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\global_config.json"
  StrCpy $R1 "$XiaomeiPreserveRoot\root\global_config.json"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\API"
  StrCpy $R1 "$XiaomeiPreserveRoot\root\API"
  Call XiaomeiMovePath
  StrCpy $R0 "$XiaomeiLegacyInstallDir\.xiaomei-data"
  StrCpy $R1 "$XiaomeiPreserveRoot\root\.xiaomei-data"
  Call XiaomeiMovePath

  ${If} $XiaomeiPreservedAnything != "1"
    ; Nothing to preserve (clean install or no user data).
    RMDir "$XiaomeiPreserveRoot\app\ComfyUI"
    RMDir "$XiaomeiPreserveRoot\app"
    RMDir "$XiaomeiPreserveRoot\root"
    RMDir "$XiaomeiPreserveRoot"
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Return
  ${EndIf}

  ; The application reads this pointer even if the installation directory is
  ; later moved or renamed.  UTF-16 keeps Chinese installation paths intact.
  CreateDirectory "$LOCALAPPDATA\小美画布\.legacy-install-paths"
  ClearErrors
  FileOpen $R0 "$LOCALAPPDATA\小美画布\.legacy-install-paths\$R3-$R7-$R8.txt" w
  ${If} ${Errors}
    StrCpy $XiaomeiFailureStage "write preservation pointer"
    StrCpy $R9 "1"
    Goto xiaomei_preserve_done
  ${EndIf}
  FileWriteUTF16LE $R0 "$XiaomeiPreserveRoot$\r$\n"
  ${If} ${Errors}
    StrCpy $XiaomeiFailureStage "write preservation pointer"
    StrCpy $R9 "1"
  ${EndIf}
  FileClose $R0

  xiaomei_preserve_done:
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

!macro XiaomeiWriteFailureLog
  ${If} $XiaomeiDiagnosticPath != ""
    Push $R0
    ClearErrors
    FileOpen $R0 "$XiaomeiDiagnosticPath" w
    ${IfNot} ${Errors}
      FileWrite $R0 "$XiaomeiFailureStage$\r$\n"
      FileClose $R0
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend

!macro customInstall
  StrCpy $XiaomeiInstallCompleted "1"
!macroend

; If the user cancels the assisted installer after customInit moved the old
; data away, put it back so the still-installed old version keeps working.
Function .onGUIEnd
  ${If} $XiaomeiPreservedAnything == "1"
  ${AndIf} $XiaomeiInstallCompleted != "1"
    Call XiaomeiRestoreLegacyData
  ${EndIf}
FunctionEnd

!macro customInit
  ReadEnvStr $XiaomeiDiagnosticPath "XIAOMEI_INSTALL_DIAGNOSTIC"
  StrCpy $XiaomeiFailureStage "select old installation"
  ReadRegStr $R8 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $R8 "" xiaomei_done

  ; Preserve the directory recorded by the old installation.  The user may
  ; have selected a different $INSTDIR for the new release in the installer.
  StrCpy $XiaomeiLegacyInstallDir "$INSTDIR"
  IfFileExists "$INSTDIR\Uninstall 小美画布.exe" xiaomei_preserve

  ReadRegStr $R7 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $R7 "" xiaomei_parse_uninstaller
  IfFileExists "$R7\Uninstall 小美画布.exe" 0 xiaomei_parse_uninstaller
  StrCpy $XiaomeiLegacyInstallDir "$R7"
  Goto xiaomei_preserve

  xiaomei_parse_uninstaller:
    ; Fall back to the parent of the executable in UninstallString.
    StrCpy $R7 $R8 1
    StrCmp $R7 '"' 0 xiaomei_parse_parent
    StrCpy $R8 $R8 "" 1
  xiaomei_parse_parent:
    ${GetParent} "$R8" $R7
    StrCmp $R7 "" xiaomei_preserve
    StrCpy $XiaomeiLegacyInstallDir "$R7"

  xiaomei_preserve:
    StrCmp $XiaomeiLegacyInstallDir "" 0 +2
    StrCpy $XiaomeiLegacyInstallDir "$INSTDIR"
    ; Move user data out of the old installation before its uninstaller
    ; deletes the directory.
    StrCpy $XiaomeiFailureStage "preserve old data"
    Call XiaomeiPreserveLegacyData
    StrCmp $R9 "1" xiaomei_preserve_failed

    IfFileExists "$XiaomeiLegacyInstallDir\Uninstall 小美画布.exe" 0 xiaomei_done

    InitPluginsDir
    ClearErrors
    StrCpy $XiaomeiFailureStage "copy old uninstaller"
    CopyFiles /SILENT "$XiaomeiLegacyInstallDir\Uninstall 小美画布.exe" "$PLUGINSDIR\xiaomei-old-uninstaller.exe"
    IfErrors xiaomei_failed
    StrCpy $XiaomeiFailureStage "run old uninstaller"
    ExecWait '"$PLUGINSDIR\xiaomei-old-uninstaller.exe" /S /KEEP_APP_DATA _?=$XiaomeiLegacyInstallDir' $R8
    StrCmp $R8 0 0 xiaomei_failed
    StrCpy $XiaomeiFailureStage "old installation remains"
    IfFileExists "$XiaomeiLegacyInstallDir\resources\app\package.json" xiaomei_failed xiaomei_done

  xiaomei_failed:
    !insertmacro XiaomeiWriteFailureLog
    Call XiaomeiRestoreLegacyData
    MessageBox MB_OK|MB_ICONSTOP "无法卸载旧版小美画布，请关闭程序后重试。" /SD IDOK
    Abort "旧版卸载失败，安装已停止。"

  xiaomei_preserve_failed:
    !insertmacro XiaomeiWriteFailureLog
    Call XiaomeiRestoreLegacyData
    MessageBox MB_OK|MB_ICONSTOP "无法保存旧版用户数据，安装已停止。请确认磁盘空间和文件权限后重试。" /SD IDOK
    Abort "旧版用户数据保存失败，安装已停止。"

  xiaomei_done:
!macroend

!endif
