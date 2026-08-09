; 自定义 NSIS：
; 1) 安装时若目标路径不存在则自动创建
; 2) 若用户只选了盘符根目录（如 D:\），自动追加产品文件夹名

!macro customInstall
  StrLen $R9 $INSTDIR
  ${if} $R9 <= 3
    StrCpy $INSTDIR "$INSTDIR${PRODUCT_NAME}"
  ${endif}
  CreateDirectory "$INSTDIR"
!macroend
