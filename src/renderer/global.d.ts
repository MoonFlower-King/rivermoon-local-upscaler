import type { UpscalerApi } from "../main/types";

declare global {
  interface Window {
    upscaler: UpscalerApi;
  }
}

export {};

