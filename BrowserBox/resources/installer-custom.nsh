; 自定义 NSIS：
; 1) 安装时若目标路径不存在则自动创建
; 2) 若用户只选了盘符根目录（如 D:\），自动追加产品文件夹名

!macro preInit
  StrCpy $0 "$PROGRAMFILES64\Google\Chrome\Application\chrome.exe"
  IfFileExists "$0" chrome_ok chrome_check_x86

chrome_check_x86:
  StrCpy $0 "$PROGRAMFILES32\Google\Chrome\Application\chrome.exe"
  IfFileExists "$0" chrome_ok chrome_check_local

chrome_check_local:
  StrCpy $0 "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  IfFileExists "$0" chrome_ok chrome_missing

chrome_missing:
  MessageBox MB_ICONSTOP|MB_OK "未检测到 Google Chrome。$\r$\n请先安装 Google Chrome，再安装浏览器多开工具。"
  Quit

chrome_ok:
!macroend

!macro customInstall
  StrLen $R9 $INSTDIR
  ${if} $R9 <= 3
    StrCpy $INSTDIR "$INSTDIR${PRODUCT_NAME}"
  ${endif}
  CreateDirectory "$INSTDIR"
!macroend
