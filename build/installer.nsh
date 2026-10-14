!macro customInit
  ReadRegStr $R8 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $R8 "" xiaomei_done
  IfFileExists "$INSTDIR\Uninstall 小美画布.exe" 0 xiaomei_done

  InitPluginsDir
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\Uninstall 小美画布.exe" "$PLUGINSDIR\xiaomei-old-uninstaller.exe"
  IfErrors xiaomei_failed
  ExecWait '"$PLUGINSDIR\xiaomei-old-uninstaller.exe" /S /KEEP_APP_DATA _?=$INSTDIR' $R8
  StrCmp $R8 0 0 xiaomei_failed
  IfFileExists "$INSTDIR\resources\app\package.json" xiaomei_failed xiaomei_done

  xiaomei_failed:
    MessageBox MB_OK|MB_ICONSTOP "无法卸载旧版小美画布，请关闭程序后重试。" /SD IDOK
    Abort "旧版卸载失败，安装已停止。"

  xiaomei_done:
!macroend
