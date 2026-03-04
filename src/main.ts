import { chromium, devices, type Page } from "playwright";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Ideally use process.env.OPENAI_API_KEY
});

export type RegistrationFormData = {
  /** Số căn cước công dân (Required) */
  idNumber: string;

  /** Họ và tên (Required) */
  fullName: string;

  /** Email (Required) */
  email: string;

  /** Điện thoại (Optional - no asterisk in image) */
  phoneNumber?: string;

  /** Tỉnh thành phố (Required) */
  province: string;

  /** Quận huyện (Required) */
  district: string;

  /** Phường Xã (Required) */
  ward: string;

  /** Số nhà, Đường (Required) */
  addressLine: string;

  /** Nhập mã Captcha (Required) */
  captcha: string;
};

async function solveRecaptchaAudio(page: Page): Promise<void> {
  // ── Step 1: find the reCAPTCHA anchor iframe and click the audio button ──
  const recaptchaFrame = page.frameLocator('iframe[src*="recaptcha"][src*="anchor"]');
  await recaptchaFrame.locator('#recaptcha-anchor').waitFor({ timeout: 10_000 }).catch(() => {});

  // Switch to the challenge bframe if the anchor checkbox is already checked,
  // otherwise click the checkbox first
  const checkbox = recaptchaFrame.locator('#recaptcha-anchor');
  const checked = await checkbox.getAttribute('aria-checked').catch(() => 'false');
  if (checked !== 'true') {
    await checkbox.click();
  }

  // ── Step 2: wait for the bframe (challenge iframe) ──
  const bframe = page.frameLocator('iframe[src*="recaptcha"][src*="bframe"]');
  // Click the audio challenge button (PHÁT)
  await bframe.locator('button#recaptcha-audio-button, button[aria-labelledby*="audio"]').waitFor({ timeout: 10_000 });
  await bframe.locator('button#recaptcha-audio-button, button[aria-labelledby*="audio"]').click();

  // ── Step 3: get the audio download URL ──
  const audioLink = bframe.locator('a.rc-audiochallenge-tdownload-link');
  await audioLink.waitFor({ timeout: 10_000 });
  const audioUrl = await audioLink.getAttribute('href');
  if (!audioUrl) throw new Error('Could not find captcha audio URL');

  console.log('Downloading captcha audio:', audioUrl);

  // ── Step 4: download the audio ──
  const audioResponse = await page.request.get(audioUrl);
  if (!audioResponse.ok()) throw new Error(`Failed to download captcha audio: ${audioResponse.status()}`);
  const audioBuffer = await audioResponse.body();

  const tmpPath = path.join(os.tmpdir(), `captcha_audio_${Date.now()}.mp3`);
  fs.writeFileSync(tmpPath, audioBuffer);

  try {
    // ── Step 5: transcribe with OpenAI Whisper ──
    console.log('Transcribing captcha audio with Whisper...');
    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tmpPath),
      response_format: 'text',
    });

    const answer = (typeof transcription === 'string' ? transcription : (transcription as any).text)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim();

    console.log('Captcha audio answer:', answer);

    // ── Step 6: fill the answer and verify ──
    await bframe.locator('input#audio-response').fill(answer);
    await bframe.locator('#recaptcha-verify-button').click();

    // Wait for the checkbox to become solved
    await recaptchaFrame.locator('#recaptcha-anchor[aria-checked="true"]').waitFor({ timeout: 10_000 });
    console.log('reCAPTCHA solved!');
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

async function solveCaptchaFromVideo(page: Page): Promise<string> {
  // Get the video src from the captcha element
  const videoSrc = await page.evaluate((): string | null => {
    const video = document.querySelector<HTMLVideoElement>("video");
    if (!video) return null;
    return video.src || video.querySelector("source")?.getAttribute("src") || null;
  });

  if (!videoSrc) throw new Error("No captcha video element found on page");

  console.log("Captcha video src:", videoSrc);

  // Download the video through the browser context (preserves session cookies)
  const videoResponse = await page.request.get(videoSrc);
  if (!videoResponse.ok()) throw new Error(`Failed to download captcha video: ${videoResponse.status()}`);
  const videoBuffer = await videoResponse.body();

  // Write to a temp file
  const tmpDir = os.tmpdir();
  const videoPath = path.join(tmpDir, `captcha_video_${Date.now()}.mp4`);
  const framesDir = path.join(tmpDir, `captcha_frames_${Date.now()}`);
  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(videoPath, videoBuffer);

  try {
    // Extract ~6 frames evenly distributed across the video using ffmpeg
    execSync(
      `ffmpeg -i "${videoPath}" -vf "fps=2,scale=320:-1" "${path.join(framesDir, "frame_%03d.png")}" -y`,
      { stdio: "pipe" }
    );

    const frameFiles = fs.readdirSync(framesDir)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .map((f) => path.join(framesDir, f));

    if (frameFiles.length === 0) throw new Error("ffmpeg produced no frames");

    console.log(`Extracted ${frameFiles.length} frames, sending to OpenAI...`);

    // Build image content for GPT-4o
    const imageContent = frameFiles.map((f) => ({
      type: "image_url" as const,
      image_url: {
        url: `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`,
      },
    }));

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "These are frames extracted from an animated captcha video. Identify the captcha characters shown across the frames. Return ONLY the captcha code (letters/digits), no explanation or punctuation.",
            },
            ...imageContent,
          ],
        },
      ],
    });

    const captchaText = response.choices[0].message.content?.trim() ?? "";
    console.log("Solved captcha:", captchaText);
    return captchaText;
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(framesDir, { recursive: true, force: true });
      fs.unlinkSync(videoPath);
    } catch {}
  }
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
  });
  const page = await context.newPage();
  await page.goto("https://tructuyen.sjc.com.vn/dang-nhap");
  await page.getByPlaceholder("Nhập họ tên").fill("Hồ Thị Ngân Huyền");
  await page.getByPlaceholder("Nhập CCCD").fill("086196009296");
  await page.getByRole("button", { name: "Đăng nhập" }).click();

  await page.locator("#select2-id_area-container").click();
  await page.getByRole('option', { name: 'Thành phố Hồ Chí Minh' }).click();

  const stores = [
    'TRỤ SỞ - TRUNG TÂM VÀNG BẠC ĐÁ QUÝ - SJC',
    'TRUNG TÂM VÀNG BẠC ĐÁ QUÝ SJC GÒ VẤP',
  ];

  let registered = false;
  for (const store of stores) {
    console.log(`Trying store: ${store}`);

    // Select the store
    await page.locator("#select2-id_store-container").click();
    await page.getByRole('option', { name: store }).click();

    // Wait for reCAPTCHA and solve it
    await page.waitForSelector('iframe[src*="recaptcha"][src*="anchor"]', { timeout: 0 });
    await solveRecaptchaAudio(page);

    // Submit the form
    await page.getByRole('button', { name: 'Đăng ký' }).click();

    // Wait briefly then check for a failure indicator (error toast / alert)
    await page.waitForTimeout(2000);

    const failed = await page.evaluate(() => {
      // Check for common error indicators: visible alert, toast, or error message
      const selectors = [
        '.alert-danger',
        '.error-message',
        '.notification-error',
        '[class*="error"]',
        '[class*="alert"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el && el.offsetParent !== null && el.innerText.trim().length > 0) return true;
      }
      return false;
    });

    if (!failed) {
      console.log(`Registration succeeded with store: ${store}`);
      registered = true;
      break;
    }

    console.log(`Registration failed for store: ${store}, trying next option...`);
  }

  if (!registered) {
    throw new Error('Registration failed for all store options');
  }
  // await page.getByPlaceholder("Vui lòng nhập điện thoại").fill("0123456789");
  // await page.selectOption("#id_province", { label: "Thành phố Hồ Chí Minh" });
  // await page.selectOption("#id_district", { label: "Quận 10" });
  // await page.selectOption("#id_ward", { label: "Phường 11" });
  // await page
  //   .getByPlaceholder("Nhập số nhà, tên đường")
  //   .fill("123 Đường Lê Lợi");

  // const captchaElement = await page.$("canvas#captcha");
  // if (!captchaElement) throw new Error("Captcha element not found");

  // const imageBuffer = await captchaElement.screenshot({ path: "captcha.png" });
  // const base64Image = imageBuffer.toString("base64");

  // console.log("Analyzing captcha...");
  // const response = await openai.chat.completions.create({
  //   model: "gpt-4o",
  //   messages: [
  //     {
  //       role: "user",
  //       content: [
  //         {
  //           type: "text",
  //           text: "Return only the characters visible in this captcha image. No explanation, just the code.",
  //         },
  //         {
  //           type: "image_url",
  //           image_url: {
  //             url: `data:image/png;base64,${base64Image}`,
  //           },
  //         },
  //       ],
  //     },
  //   ],
  // });

  // const captchaText = response.choices[0].message.content?.trim() || "";

  // await page.getByPlaceholder("Nhập mã Captcha").fill(captchaText);
}

main();
