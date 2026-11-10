; Harness Hub 安装器(per-user, 不需要管理员权限)。
; 由 scripts/pack-portable.mjs 调用:
;   makensis /DPKG_DIR=<打包目录> /DOUT_FILE=<setup.exe> /DAPP_VERSION=<版本> scripts/installer.nsi
; 注意: 卸载时保留 data\(任务、配置、工作区), 只删程序文件。

Unicode true
!include "MUI2.nsh"

!ifndef PKG_DIR
  !error "需要 /DPKG_DIR=<打包目录>"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "HarnessHub-setup.exe"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif

!define APP_NAME "Harness Hub"
!define APP_EXE "HarnessHub.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\HarnessHub"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\HarnessHub"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallDir"
RequestExecutionLevel user
; 不用 /SOLID lzma: 300 MB 级别的 Electron 负载会让 32 位 makensis 申请 mmap 失败
; (Internal compiler error #12345: error creating mmap)。zlib 按文件压, 稳一些。
SetCompressor zlib
ShowInstDetails show

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "启动 Harness Hub"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  IfFileExists "$INSTDIR\data\runtime.json" 0 initDone
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
    "检测到 Harness Hub 可能正在运行。$\r$\n$\r$\n请先关闭它的窗口(或在任务管理器里结束 HarnessHubCore.exe), 然后点「重试」。" \
    IDRETRY retry
  Abort
  retry:
  IfFileExists "$INSTDIR\data\runtime.json" 0 initDone
  MessageBox MB_OK|MB_ICONSTOP "仍然检测到运行中的实例, 安装已取消。关闭后再运行安装程序。"
  Abort
  initDone:
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r /x data "${PKG_DIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Harness Hub"
  CreateShortcut "$SMPROGRAMS\Harness Hub\Harness Hub.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\Harness Hub\卸载 Harness Hub.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Harness Hub.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "1hobby"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  IfFileExists "$INSTDIR\data\runtime.json" 0 unInitDone
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
    "检测到 Harness Hub 可能正在运行。$\r$\n$\r$\n请先关闭它的窗口(或在任务管理器里结束 HarnessHubCore.exe), 然后点「重试」。" \
    IDRETRY unRetry
  Abort
  unRetry:
  IfFileExists "$INSTDIR\data\runtime.json" 0 unInitDone
  MessageBox MB_OK|MB_ICONSTOP "仍然检测到运行中的实例, 卸载已取消。关闭后再运行卸载程序。"
  Abort
  unInitDone:
FunctionEnd

Section "Uninstall"
  Delete "$DESKTOP\Harness Hub.lnk"
  RMDir /r "$SMPROGRAMS\Harness Hub"

  ; 只删程序文件; data\ 是用户的任务与配置, 必须留着。
  Delete "$INSTDIR\HarnessHub.exe"
  Delete "$INSTDIR\HarnessHubCore.exe"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.vbs"
  Delete "$INSTDIR\*.txt"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\version"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\dist"
  RMDir /r "$INSTDIR\node_modules"
  RMDir /r "$INSTDIR\scripts"
  RMDir /r "$INSTDIR\apps"

  DeleteRegKey HKCU "${UNINST_KEY}"
  ; data\ 还在时这里不会生效, 用户数据因此得以保留。
  RMDir "$INSTDIR"
SectionEnd
