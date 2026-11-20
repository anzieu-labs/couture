// Captures the garment picker's pictures (public/garments/<id>.webp): each garment of
// lib/pattern/garments.ts, sewn and draped on the default mannequin, front view, the
// interface hidden, cropped to 3:4.
//
//   npm i --no-save playwright-core        (no browser download: uses the installed Chrome)
//   node tools/thumbnails/capture.mjs [app URL, default http://localhost:3000]
//
// CHROME=/path/to/chrome overrides the browser. WebGPU is needed for the GPU drape
// (otherwise the CPU fallback is used: slower, same result).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const url = process.argv[2] ?? "http://localhost:3000/";
const out = join(root, "public/garments");
const SIZE = { w: 480, h: 640 };

// Garments, from the catalogue source (id, name, image path).
const src = readFileSync(join(root, "lib/pattern/garments.ts"), "utf8");
const garments = [...src.matchAll(/id: "([^"]+)",\s*name: "([^"]+)",[\s\S]*?image: "([^"]+)"/g)].map(([, id, name, image]) => ({ id, name, image }));
if (!garments.length) throw new Error("No garment found in lib/pattern/garments.ts");

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "load" });
await page.getByRole("tab", { name: "Patron" }).click();
await page.getByText("Le patron suit la morphologie").waitFor({ timeout: 90_000 });
mkdirSync(out, { recursive: true });

const view = page.locator('section[aria-label="Aperçu 3D"]');
for (const g of garments) {
  await page.getByRole("button", { name: "Changer", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: g.name }).click();
  await page.waitForTimeout(2_000); // the new garment is being prepared
  await page.getByText("Le patron suit la morphologie").waitFor({ timeout: 90_000 }); // sewn, draped, at rest
  await page.getByRole("button", { name: "Face", exact: true }).click();
  await page.waitForTimeout(1_500); // camera move

  // Only the 3D canvas: every overlay of the view hidden.
  const style = await page.addStyleTag({ content: 'section[aria-label="Aperçu 3D"] > div:last-child > :not(:first-child) { visibility: hidden !important; }' });
  const box = await view.boundingBox();
  const h = box.height - 40, w = (h * SIZE.w) / SIZE.h;
  const png = await page.screenshot({ clip: { x: box.x + (box.width - w) / 2, y: box.y + 20, width: w, height: h } });
  await style.evaluate((el) => el.remove());

  const webp = await page.evaluate(
    async ({ b64, size }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = size.w;
      c.height = size.h;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, size.w, size.h);
      return c.toDataURL("image/webp", 0.86).split(",")[1];
    },
    { b64: png.toString("base64"), size: SIZE },
  );
  const file = join(root, "public", g.image);
  writeFileSync(file, Buffer.from(webp, "base64"));
  console.log(`${g.name} → ${g.image} (${Math.round(Buffer.from(webp, "base64").length / 1024)} Ko)`);
}
await browser.close();
