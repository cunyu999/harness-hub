// Harness Hub 启动器(WinExe, 无控制台)。
//
// 为什么不直接双击 Electron 内核 exe: 双击无法带命令行参数, 而这台机器上 Chromium 的
// 沙箱初始化会让进程在加载 JS 之前直接 0xC0000005 退出(DSH 自己的 Electron 也是带
// --no-sandbox 跑的)。所以由这个 10KB 的小壳子负责:
//   1. SetErrorMode 关掉硬错误弹窗(会传给 node 及后面的 harness 子进程);
//   2. 带 --no-sandbox 启动 HarnessHubCore.exe(Electron 内核);
//   3. 设置 HH_ERROR_MODE=1, 让后端不再经 PowerShell 重新拉起自己。
// 打包时用系统自带 csc 现编, 不引入 .NET SDK 或任何第三方依赖。

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    [DllImport("kernel32.dll")]
    private static extern uint SetErrorMode(uint uMode);

    [STAThread]
    private static int Main(string[] args)
    {
        // SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX
        SetErrorMode(0x0001u | 0x0002u | 0x8000u);

        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string core = Path.Combine(dir, "HarnessHubCore.exe");
        if (!File.Exists(core))
        {
            WriteLog(dir, "找不到 HarnessHubCore.exe: " + core);
            return 1;
        }

        StringBuilder arguments = new StringBuilder("--no-sandbox");
        for (int i = 0; i < args.Length; i++)
        {
            arguments.Append(' ');
            arguments.Append(Quote(args[i]));
        }

        // 临时目录也收进安装目录: Chromium 与后面的 harness 子进程(含 node)都继承
        // TEMP/TMP, 免得运行时在 %LOCALAPPDATA%\Temp 留东西。建不出来就退回系统默认,
        // 但至少记一笔。
        string tmp = Path.Combine(dir, "data", "tmp");
        bool tmpReady = false;
        try
        {
            Directory.CreateDirectory(tmp);
            tmpReady = true;
        }
        catch (Exception ex)
        {
            WriteLog(dir, "创建 data/tmp 失败, 退回系统 TEMP: " + ex.Message);
        }

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(core, arguments.ToString());
            psi.UseShellExecute = false;
            psi.WorkingDirectory = dir;
            psi.EnvironmentVariables["HH_ERROR_MODE"] = "1";
            if (tmpReady)
            {
                psi.EnvironmentVariables["TEMP"] = tmp;
                psi.EnvironmentVariables["TMP"] = tmp;
                psi.EnvironmentVariables["TMPDIR"] = tmp;
            }
            // 从被 Electron 宿主继承来的环境里去掉这个开关, 否则内核会以纯 Node 模式跑
            psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            Process.Start(psi);
            return 0;
        }
        catch (Exception ex)
        {
            WriteLog(dir, "启动 HarnessHubCore.exe 失败: " + ex.Message);
            return 1;
        }
    }

    private static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (value.IndexOf(' ') < 0 && value.IndexOf('\t') < 0 && value.IndexOf('"') < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void WriteLog(string dir, string line)
    {
        try
        {
            string logs = Path.Combine(dir, "data", "logs");
            Directory.CreateDirectory(logs);
            File.AppendAllText(
                Path.Combine(logs, "launcher.log"),
                "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + line + Environment.NewLine,
                Encoding.UTF8);
        }
        catch
        {
            // 日志写不了也不能影响启动
        }
    }
}
