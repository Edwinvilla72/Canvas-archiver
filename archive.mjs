
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";

const BASE_URL = "https://webcourses.ucf.edu";
const ARCHIVE_DIR = process.env.ARCHIVE_DIR;
const DOWNLOAD_ALL = process.env.DOWNLOAD_ALL === "true";

const DOWNLOAD_DELAY_MS = 1500;
const MAX_RETRIES = 3;

if (!ARCHIVE_DIR) {
  throw new Error("Set ARCHIVE_DIR before running.");
}

await fs.mkdir(ARCHIVE_DIR, { recursive: true });

const browser = await chromium.launch({
  headless: false,
});

const context = await browser.newContext({
  acceptDownloads: true,
});

const page = await context.newPage();

const report = {
  startedAt: new Date().toISOString(),
  downloaded: [],
  skipped: [],
  failed: [],
  folders: [],
  courses: [],
};

const visitedFolders = new Set();
const processedFiles = new Set();

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function safeName(name) {
  return String(name || "Unnamed")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 150);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function saveReport() {
  report.updatedAt = new Date().toISOString();

  await fs.writeFile(
    path.join(ARCHIVE_DIR, "archive-report.json"),
    JSON.stringify(report, null, 2)
  );
}

// --------------------------------------------------
// Discover all courses visible on Canvas All Courses
// --------------------------------------------------

async function discoverCourses() {
  console.log("\nDiscovering Canvas courses...");

  await page.goto(`${BASE_URL}/courses`, {
    waitUntil: "domcontentloaded",
  });

  await page.locator(
    'a[href*="/courses/"]'
  ).first().waitFor({ timeout: 20000 });

  const courses = await page.locator(
    'a[href*="/courses/"]'
  ).evaluateAll(links => {
    const results = [];

    for (const link of links) {
      const url = new URL(link.href);

      const match = url.pathname.match(
        /^\/courses\/(\d+)\/?$/
      );

      if (!match) continue;

      const name = link.textContent?.trim();

      if (!name) continue;

      results.push({
        id: match[1],
        name,
        url: `${url.origin}/courses/${match[1]}`,
      });
    }

    return results;
  });

  const unique = [
    ...new Map(
      courses.map(course => [course.id, course])
    ).values()
  ];

  await fs.writeFile(
    path.join(ARCHIVE_DIR, "courses.json"),
    JSON.stringify(unique, null, 2)
  );

  console.log(`Found ${unique.length} courses.`);

  for (const course of unique) {
    console.log(`  ${course.id}: ${course.name}`);
  }

  return unique;
}

// --------------------------------------------------
// Download one Canvas file
// --------------------------------------------------

async function downloadFile(file, destinationDir) {
  if (processedFiles.has(file.id)) return;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", {
          timeout: 45000,
        }),
        page.evaluate(url => {
          const a = document.createElement("a");
          a.href = url;
          a.click();
        }, file.url),
      ]);

      const filename = safeName(
        download.suggestedFilename()
      );

      const destination = path.join(
        destinationDir,
        `${file.id}_${filename}`
      );

      if (await exists(destination)) {
        await download.cancel();

        console.log(`Skipping: ${filename}`);
        report.skipped.push(destination);
        processedFiles.add(file.id);
        return;
      }

      await download.saveAs(destination);

      processedFiles.add(file.id);
      report.downloaded.push(destination);

      console.log(`Downloaded: ${filename}`);

      await sleep(DOWNLOAD_DELAY_MS);
      return;

    } catch (error) {
      console.error(
        `Attempt ${attempt}/${MAX_RETRIES} failed for ${file.id}:`,
        error.message
      );

      if (attempt < MAX_RETRIES) {
        await sleep(DOWNLOAD_DELAY_MS * attempt);
      } else {
        report.failed.push({
          type: "file",
          id: file.id,
          url: file.url,
          error: error.message,
        });
      }
    }
  }
}

// --------------------------------------------------
// Recursively traverse a Canvas folder
// --------------------------------------------------

async function scanFolder(folderUrl, localPath, depth = 0) {
  if (visitedFolders.has(folderUrl)) return;

  visitedFolders.add(folderUrl);

  await fs.mkdir(localPath, { recursive: true });

  console.log(
    `${"  ".repeat(depth)}Scanning: ${localPath}`
  );

  await page.goto(folderUrl, {
    waitUntil: "domcontentloaded",
  });

  // Wait for Canvas file browser.
  await page.locator(
    ".ef-name-col__link"
  ).first().waitFor({
    state: "visible",
    timeout: 20000,
  }).catch(() => {
    console.log(
      "No file entries found or folder is empty."
    );
  });

  // Discover downloadable files in current folder.
  const files = await page.locator(
    'a[href*="/files/"][href*="/download"]'
  ).evaluateAll(elements =>
    elements.map(a => ({
      id: a.href.match(/\/files\/(\d+)/)?.[1],
      url: a.href,
    })).filter(f => f.id)
  );

  const uniqueFiles = [
    ...new Map(
      files.map(file => [file.id, file])
    ).values()
  ];

  // Discover folders using Canvas file-table links.
  const folders = await page.locator(
    'a.ef-name-col__link[href*="/files/folder/"]'
  ).evaluateAll(elements =>
    elements.map(a => ({
      name:
        a.querySelector(".ef-name-col__text")
          ?.textContent?.trim() || "Unnamed Folder",
      url: a.href,
    }))
  );

  const uniqueFolders = [
    ...new Map(
      folders.map(folder => [folder.url, folder])
    ).values()
  ];

  report.folders.push({
    path: localPath,
    files: uniqueFiles.length,
    subfolders: uniqueFolders.length,
  });

  console.log(
    `${"  ".repeat(depth)}Found ` +
    `${uniqueFiles.length} files and ` +
    `${uniqueFolders.length} subfolders`
  );

  for (const file of uniqueFiles) {
    await downloadFile(file, localPath);
  }

  for (const folder of uniqueFolders) {
    const childPath = path.join(
      localPath,
      safeName(folder.name)
    );

    await scanFolder(
      folder.url,
      childPath,
      depth + 1
    );
  }
}

// --------------------------------------------------
// Main execution
// --------------------------------------------------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

try {
  await page.goto(BASE_URL);

  await rl.question(
    "\nLog in to UCF Canvas, then press Enter: "
  );

  const courses = await discoverCourses();

  if (courses.length === 0) {
    throw new Error(
      "No courses discovered. Check the All Courses page."
    );
  }

  if (!DOWNLOAD_ALL) {
    console.log(
      "\nDiscovery complete. No files downloaded."
    );

    console.log(
      "Review courses.json before starting downloads."
    );
  } else {
    console.log(
      `\nStarting archive of ${courses.length} courses.`
    );

    for (const course of courses) {
      console.log(
        `\n====================================\n` +
        `Course: ${course.name}\n` +
        `ID: ${course.id}\n` +
        `====================================`
      );

      visitedFolders.clear();
      processedFiles.clear();

      const courseDir = path.join(
        ARCHIVE_DIR,
        `${course.id}_${safeName(course.name)}`
      );

      const filesUrl =
        `${BASE_URL}/courses/${course.id}/files`;

      try {
        await scanFolder(filesUrl, courseDir);

        report.courses.push({
          id: course.id,
          name: course.name,
          status: "processed",
        });

      } catch (error) {
        console.error(
          `Course failed: ${course.name}`,
          error.message
        );

        report.failed.push({
          type: "course",
          id: course.id,
          name: course.name,
          error: error.message,
        });

        report.courses.push({
          id: course.id,
          name: course.name,
          status: "failed",
        });
      }

      await saveReport();
      await sleep(DOWNLOAD_DELAY_MS);
    }

    console.log("\nArchive complete.");
    console.log(
      `Downloaded: ${report.downloaded.length}`
    );
    console.log(
      `Skipped: ${report.skipped.length}`
    );
    console.log(
      `Failed: ${report.failed.length}`
    );
    console.log(
      `Folders scanned: ${report.folders.length}`
    );
  }

} catch (error) {
  console.error("Fatal error:", error.message);
  process.exitCode = 1;

} finally {
  await saveReport();
  rl.close();
  await browser.close();
}
