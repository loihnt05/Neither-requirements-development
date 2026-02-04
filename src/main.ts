import { chromium, devices } from "playwright";
import OpenAI from "openai";
import dotenv from "dotenv";
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
async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
  });
  const page = await context.newPage();
  await page.goto("https://tructuyen.sjc.com.vn/dang-nhap");
  await page.getByPlaceholder("Nhập họ tên").fill("Hò Thị Ngọc Quỳnh");
  await page.getByPlaceholder("Nhập CCCD").fill("086193005734");
  await page.getByRole("button", { name: "Đăng nhập" }).click();

  await page.locator("#select2-id_area-container").click();
  await page.getByRole('option', { name: 'Thành phố Hồ Chí Minh' }).click();
  await page.locator("#select2-id_store-container").click();
  await page.getByRole('option', { name: 'TRỤ SỞ - TRUNG TÂM VÀNG BẠC ĐÁ QUÝ - SJC' }).click();
  // await page.selectOption("select2-id_store-container", { label: "TRUNG TÂM VÀNG BẠC ĐÁ QUÝ SJC GÒ VẤP"})
  
  // await page.locator("#select2-id_hinhthuc-container").click();
  // await page.getByRole("option", {name: 'Tiền mặt'}).click();

  
  // await page.getByPlaceholder("Vui lòng nhập Email").fill("hentaiz@gmail.com");
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
