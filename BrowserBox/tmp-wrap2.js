const fs=require("fs");
const {app}=require("electron");
const log=(m)=>{fs.appendFileSync("tmp-main.log", m+"\n"); console.error(m)};
Remove = () => {};
fs.writeFileSync("tmp-main.log","");
log("start");
app.whenReady().then(async()=>{
  log("ready");
  try {
    const { ensureDataDirReady } = require("./out/main/index.js");
    log("cannot require ensure from index");
  } catch(e) {}
  // load modules via electron path - use dynamic from built chunks? 
  // Instead require the compiled deps by evaluating from app
  log("done skip");
  app.quit();
});
