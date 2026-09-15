function readError(path, error) {
  const detail = error?.message || String(error || "浏览器拒绝读取");
  return new Error(`无法读取拖入的文件或目录 ${path}：${detail}`);
}

function withRelativePath(file, relativePath) {
  // Keep native Blob/File identity so the same drop handler also works for map
  // textures via URL.createObjectURL. Copying a Blob does not eagerly read it.
  if (typeof File !== "undefined" && typeof Blob !== "undefined" && file instanceof Blob) {
    const copy = new File([file], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });
    Object.defineProperty(copy, "webkitRelativePath", { value: relativePath });
    return copy;
  }

  const copy = {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    webkitRelativePath: relativePath,
  };
  for (const method of ["text", "arrayBuffer", "slice", "stream"]) {
    if (typeof file[method] === "function") copy[method] = file[method].bind(file);
  }
  return copy;
}

function readFileEntry(entry, relativePath) {
  return new Promise((resolve, reject) => {
    try {
      entry.file(
        (file) => {
          try {
            resolve(withRelativePath(file, relativePath));
          } catch (error) {
            reject(readError(relativePath, error));
          }
        },
        (error) => reject(readError(relativePath, error)),
      );
    } catch (error) {
      reject(readError(relativePath, error));
    }
  });
}

async function readEntry(entry, parentPath = "") {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) return [await readFileEntry(entry, relativePath)];
  if (!entry.isDirectory) throw readError(relativePath, "不支持的文件类型");

  let reader;
  try {
    reader = entry.createReader();
  } catch (error) {
    throw readError(relativePath, error);
  }
  const files = [];
  while (true) {
    const entries = await new Promise((resolve, reject) => {
      try {
        reader.readEntries(resolve, (error) => reject(readError(relativePath, error)));
      } catch (error) {
        reject(readError(relativePath, error));
      }
    });
    // Chromium returns directory entries in batches (often at most 100). A
    // single readEntries call can silently omit sessions from a large archive.
    if (!entries.length) return files;
    const batches = await Promise.all(entries.map((child) => readEntry(child, relativePath)));
    files.push(...batches.flat());
  }
}

export async function collectDroppedFiles(dataTransfer) {
  // Snapshot every item/entry before the first await. The browser protects the
  // DataTransfer store as soon as the synchronous drop handler has returned.
  const fallbackFiles = Array.from(dataTransfer?.files || []);
  const items = Array.from(dataTransfer?.items || []).filter((item) => item.kind === "file");
  const sources = items.map((item) => {
    const getEntry = item.getAsEntry || item.webkitGetAsEntry;
    const entry = typeof getEntry === "function" ? getEntry.call(item) : null;
    return entry ? { entry } : { file: item.getAsFile?.() };
  });
  if (!sources.length) return fallbackFiles;

  const batches = await Promise.all(sources.map(({ entry, file }) => {
    if (entry) return readEntry(entry);
    if (file) return [file];
    throw new Error("浏览器未能读取拖入的文件，请使用足迹目录或日志选择按钮。");
  }));
  return batches.flat();
}
