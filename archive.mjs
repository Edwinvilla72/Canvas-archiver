
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import 'dotenv/config';

const COURSE_ID = process.env.COURSE_ID;
const ARCHIVE_DIR = process.env.ARCHIVE_DIR;

if (!COURSE_ID || !/^\d+$/.test(COURSE_ID) || !ARCHIVE_DIR) {
    throw new Error("Set COURSE_ID and ARCHIVE_DIR.");
}

const BASE_URL = "https://webcourses.ucf.edu";
const FILES_URL = `${BASE_URL}/courses/${COURSE_ID}/files`;

await fs.mkdir(ARCHIVE_DIR, { recursive: true });

const browser = await chromium.launch({
    headless: false,
});

const context = await browser.newContext({
    acceptDownloads: true,
});

const page = await context.newPage();

const visitedFolders = new Set();
const downloadedFiles = new Set();

const report = {
    downloaded: [],
    skipped: [],
    failed: [],
    folders: [],
};

function safeName(name) {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .trim();
}

async function downloadFile(file, destinationDir) {
    if (downloadedFiles.has(file.id)) return;

    downloadedFiles.add(file.id);

    try {
        const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 30000 }),
            page.evaluate(url => {
                const a = document.createElement("a");
                a.href = url;
                a.click();
            }, file.url),
        ]);

        const filename = safeName(download.suggestedFilename());
        const destination = path.join(
            destinationDir,
            `${file.id}_${filename}`
        );

        try {
            await fs.access(destination);
            report.skipped.push(destination);
            await download.cancel();
            return;
        } catch {
            // Not previously downloaded.
        }

        await download.saveAs(destination);
        report.downloaded.push(destination);

        console.log(`Downloaded: ${destination}`);

    } catch (error) {
        report.failed.push({
            file: file.id,
            error: error.message,
        });

        console.error(`Failed: ${file.id}`, error.message);
    }
}

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

    await page.locator(
        ".ef-name-col__link"
    ).first().waitFor({
        state: "visible",
        timeout: 20000,
    }).catch(() => {
        console.log(
            "No visible file entries found; checking folder state."
        );
    });

    // Give Canvas time to render its file browser.
    await page.locator(
        'a[href*="/files/"]'
    ).first().waitFor({ timeout: 15000 }).catch(() => { });

    // Capture downloadable files in the current view.
    const files = await page.locator(
        'a[href*="/files/"][href*="/download"]'
    ).evaluateAll(elements =>
        elements.map(a => ({
            id: a.href.match(/\/files\/(\d+)/)?.[1],
            url: a.href,
        })).filter(item => item.id)
    );

    // Folder links can vary by Canvas version.

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

    console.log(
        `Found ${uniqueFolders.length} subfolders`
    );


    console.log(
        "FOLDER DEBUG:",
        JSON.stringify(folders, null, 2)
    );


    const uniqueFiles = [
        ...new Map(files.map(f => [f.id, f])).values()
    ];

    report.folders.push({
        path: localPath,
        files: uniqueFiles.length,
        folders: uniqueFolders.length,
    });

    for (const file of uniqueFiles) {
        await downloadFile(file, localPath);
    }

    for (const folder of uniqueFolders) {
        const name = safeName(folder.name);

        await scanFolder(
            folder.url,
            path.join(localPath, name),
            depth + 1
        );
    }
}

try {
    await page.goto(BASE_URL);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    await rl.question(
        "Log in to Canvas, then press Enter: "
    );

    await scanFolder(FILES_URL, ARCHIVE_DIR);

    rl.close();

    await fs.writeFile(
        path.join(ARCHIVE_DIR, "archive-report.json"),
        JSON.stringify(report, null, 2)
    );

    console.log("\nArchive complete.");
    console.log(`Downloaded: ${report.downloaded.length}`);
    console.log(`Skipped: ${report.skipped.length}`);
    console.log(`Failed: ${report.failed.length}`);
    console.log(`Folders scanned: ${report.folders.length}`);

} finally {
    await browser.close();
}
