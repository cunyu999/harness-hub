# 现代化的 Windows 选目录对话框(和 Codex / 新版资源管理器一样的那种)。
# 用的是 shell 的 IFileOpenDialog + FOS_PICKFOLDERS, 不是老的 FolderBrowserDialog。
# 用法: powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File pick-folder.ps1 -Initial "D:\1hobby"
# 输出: SELECTED:<绝对路径> 表示选中; 无输出表示取消。

param(
  [string]$Initial = '',
  [string]$Title = '选择任务工作区'
)

$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Runtime.InteropServices;

namespace ShellPick
{
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    internal class FileOpenDialogRCW { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder([MarshalAs(UnmanagedType.Interface)] IShellItem psi);
        void SetFolder([MarshalAs(UnmanagedType.Interface)] IShellItem psi);
        void GetFolder(out IntPtr ppsi);
        void GetCurrentSelection(out IntPtr ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName(out IntPtr pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        void AddPlace(IntPtr psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IntPtr ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IntPtr psi, uint hint, out int piOrder);
    }

    public static class Picker
    {
        private const uint FOS_PICKFOLDERS = 0x00000020;
        private const uint FOS_FORCEFILESYSTEM = 0x00000040;
        private const uint FOS_PATHMUSTEXIST = 0x00000800;
        private const uint SIGDN_FILESYSPATH = 0x80058000;

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

        public static string Show(string title, string initial)
        {
            var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            dialog.SetTitle(title);
            dialog.SetOkButtonLabel("选择这个文件夹");

            if (!string.IsNullOrWhiteSpace(initial) && System.IO.Directory.Exists(initial))
            {
                try
                {
                    IShellItem start;
                    var iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                    SHCreateItemFromParsingName(initial, IntPtr.Zero, iid, out start);
                    dialog.SetFolder(start);
                }
                catch { /* 起点无效就不设, 用系统默认 */ }
            }

            int hr = dialog.Show(IntPtr.Zero);
            if (hr != 0) return null; // 取消 (HRESULT_FROM_WIN32(ERROR_CANCELLED) = 0x800704C7)

            IShellItem item;
            dialog.GetResult(out item);
            if (item == null) return null;
            string path;
            item.GetDisplayName(SIGDN_FILESYSPATH, out path);
            return path;
        }
    }
}
'@

Add-Type -TypeDefinition $code -Language CSharp | Out-Null

$picked = [ShellPick.Picker]::Show($Title, $Initial)
if ($picked) {
  Write-Output ('SELECTED:' + $picked)
}
