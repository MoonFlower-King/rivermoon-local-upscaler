/** Windows STATUS_DLL_NOT_FOUND (0xC0000135)，引擎缺少依赖 DLL（通常是 Vulkan 运行库）时的退出码。 */
export const STATUS_DLL_NOT_FOUND = 3221225781;

export type EngineDiagnosis = {
  /** 一句话中文问题描述。 */
  issue: string;
  /** 中文修复建议。 */
  hints: string[];
};

/**
 * 根据引擎退出码 + 输出，把常见失败归因成统一的中文提示。
 * 自检失败（hardware-probe）和运行期超分失败（upscaler-engine）共用，保证措辞一致。
 */
export function diagnoseEngineFailure(code: number | null, output: string): EngineDiagnosis {
  const text = output.toLowerCase();

  if (code === STATUS_DLL_NOT_FOUND || text.includes("vulkan-1.dll") || text.includes("0xc0000135")) {
    return {
      issue: "系统缺少 Vulkan 运行库，超分引擎无法启动。",
      hints: ["请安装或更新官方显卡驱动以获得 Vulkan 运行库，然后重试。"]
    };
  }

  if (text.includes("no vulkan device") || text.includes("vkcreateinstance") || text.includes("vkenumerate")) {
    return {
      issue: "未检测到支持 Vulkan 的显卡。",
      hints: [
        "请确认本机配有支持 Vulkan 的独立或集成显卡，并安装最新官方驱动。",
        "若通过远程桌面/虚拟显示器运行，请在本机物理显示器环境下重试。"
      ]
    };
  }

  if (text.includes("out of memory") || text.includes("out of device memory") || text.includes("vkallocatememory")) {
    return {
      issue: "显存不足，或分块过大。",
      hints: ["请在超分设置中把分块大小改为 256 / 128 后重试。"]
    };
  }

  return {
    issue: `超分引擎运行失败${code === null ? "" : `（退出码 ${code}）`}。`,
    hints: ["如果是 Vulkan、显卡驱动或显存问题，请更新显卡驱动，或把分块大小改为 256 / 128 后重试。"]
  };
}
