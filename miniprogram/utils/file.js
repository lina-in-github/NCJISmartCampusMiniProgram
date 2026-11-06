/* 附件选择与预览：把小程序文件系统里的文件读成 base64，交给 `/api/upload`。 */
var strings = require("./strings");
var attachments = require("./attachments");

var MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

function extensionOf(name) {
  var text = String(name || "");
  var idx = text.lastIndexOf(".");
  return idx >= 0 ? text.slice(idx + 1).toLowerCase() : "";
}

function guessMime(name) {
  return MIME_BY_EXT[extensionOf(name)] || "application/octet-stream";
}

function hasWx() {
  return typeof wx !== "undefined" && wx && typeof wx.getFileSystemManager === "function";
}

function readBase64(path) {
  return new Promise(function (resolve) {
    if (!hasWx()) {
      resolve({ ok: false, msg: "file system is not available" });
      return;
    }
    try {
      var fs = wx.getFileSystemManager();
      var data = fs.readFileSync(path, "base64");
      resolve({ ok: true, data: data });
    } catch (e) {
      resolve({ ok: false, msg: (e && e.message) || "read failed" });
    }
  });
}

/** 选择文件（聊天文件 / 相册图片），返回 `{ok, files:[{name, mime, data}]}` */
function pickFiles(limit) {
  var max = Math.min(limit || attachments.MAX_ATTACHMENTS, attachments.MAX_ATTACHMENTS);
  return new Promise(function (resolve) {
    if (typeof wx === "undefined" || !wx) {
      resolve({ ok: false, msg: "wx is not available in this environment" });
      return;
    }
    function handle(paths, names) {
      var files = [];
      var chain = Promise.resolve();
      paths.forEach(function (path, idx) {
        chain = chain.then(function () {
          return readBase64(path).then(function (res) {
            if (!res.ok) return;
            var name = names[idx] || path.split("/").pop();
            files.push({ name: name, mime: guessMime(name), data: res.data });
          });
        });
      });
      chain.then(function () {
        resolve({ ok: true, files: files });
      });
    }

    if (typeof wx.chooseMessageFile === "function") {
      wx.chooseMessageFile({
        count: max,
        type: "all",
        success: function (res) {
          var files = (res.tempFiles || []).slice(0, max);
          handle(
            files.map(function (f) {
              return f.path;
            }),
            files.map(function (f) {
              return f.name;
            })
          );
        },
        fail: function (err) {
          resolve({ ok: false, cancel: /cancel/i.test((err && err.errMsg) || ""), msg: (err && err.errMsg) || "cancel" });
        },
      });
      return;
    }

    if (typeof wx.chooseImage === "function") {
      wx.chooseImage({
        count: max,
        success: function (res) {
          var paths = (res.tempFilePaths || []).slice(0, max);
          handle(
            paths,
            paths.map(function (p, i) {
              return "image-" + (i + 1) + "." + (extensionOf(p) || "png");
            })
          );
        },
        fail: function (err) {
          resolve({ ok: false, cancel: true, msg: (err && err.errMsg) || "cancel" });
        },
      });
      return;
    }

    resolve({ ok: false, msg: "no file picker available" });
  });
}

/** 把 base64 附件写到本地临时文件，返回路径 */
function writeTempFile(attachment) {
  return new Promise(function (resolve) {
    if (!hasWx()) {
      resolve({ ok: false, msg: "file system is not available" });
      return;
    }
    var name = String(attachment.name || "attachment.bin").replace(/[\\/:*?"<>|]/g, "_");
    var path = wx.env.USER_DATA_PATH + "/sc_" + Date.now() + "_" + name;
    try {
      wx.getFileSystemManager().writeFileSync(path, attachment.data, "base64");
      resolve({ ok: true, path: path });
    } catch (e) {
      resolve({ ok: false, msg: (e && e.message) || "write failed" });
    }
  });
}

/** 预览 / 打开一个附件：图片走 previewImage，其余走 openDocument */
function openAttachment(attachment) {
  return writeTempFile(attachment).then(function (res) {
    if (!res.ok) return res;
    return new Promise(function (resolve) {
      if (attachment.isImage && typeof wx.previewImage === "function") {
        wx.previewImage({
          urls: [res.path],
          success: function () {
            resolve({ ok: true });
          },
          fail: function () {
            resolve({ ok: false, msg: strings.t("toast_copy_failed") });
          },
        });
        return;
      }
      if (typeof wx.openDocument === "function") {
        var ext = extensionOf(attachment.name);
        var opts = {
          filePath: res.path,
          showMenu: true,
          success: function () {
            resolve({ ok: true });
          },
          fail: function () {
            resolve({ ok: false, msg: "cannot open " + ext + " file" });
          },
        };
        if (ext === "pdf") opts.fileType = "pdf";
        wx.openDocument(opts);
        return;
      }
      resolve({ ok: false, msg: "cannot open attachment" });
    });
  });
}

module.exports = {
  pickFiles: pickFiles,
  guessMime: guessMime,
  readBase64: readBase64,
  writeTempFile: writeTempFile,
  openAttachment: openAttachment,
};
