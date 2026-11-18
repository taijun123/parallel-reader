using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Setup
{
    private const string AppName = "对读 PDF 阅读器";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\ParallelReader";
    private const long PayloadMarker = 0x5245414445525A50;

    [STAThread]
    private static int Main(string[] args)
    {
        bool quiet = Array.IndexOf(args, "--quiet") >= 0;
        try
        {
            string testRoot = Environment.GetEnvironmentVariable("PARALLEL_READER_TEST_ROOT");
            bool testing = !String.IsNullOrEmpty(testRoot);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string destination = testing ? Path.Combine(testRoot, "program") : Path.Combine(local, "Programs", "ParallelReader");
            string data = testing ? Path.Combine(testRoot, "data") : Path.Combine(local, "ParallelReader");
            string mutexName = @"Local\ParallelReader-" + (testing ? testRoot.GetHashCode().ToString("X8") : Environment.UserName);
            if (!quiet && MessageBox.Show("将对读安装到当前 Windows 用户，并在开始菜单创建快捷方式。", AppName,
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK)
                return 0;

            using (var mutex = new Mutex(false, mutexName))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) throw new InvalidOperationException("请关闭对读窗口，再运行安装程序。");
                try { Install(destination, data, testing); }
                finally { mutex.ReleaseMutex(); }
            }
            if (Array.IndexOf(args, "--no-launch") < 0) Process.Start(Path.Combine(destination, "ParallelReader.exe"));
            return 0;
        }
        catch (Exception error)
        {
            string testRoot = Environment.GetEnvironmentVariable("PARALLEL_READER_TEST_ROOT");
            string logRoot = !String.IsNullOrEmpty(testRoot) ? testRoot :
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ParallelReader");
            try
            {
                Directory.CreateDirectory(logRoot);
                File.WriteAllText(Path.Combine(logRoot, "setup-error.txt"), error.ToString());
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            if (!quiet) MessageBox.Show(error.Message, AppName + "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void Install(string target, string data, bool testing)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(target));
        Directory.CreateDirectory(data);
        string staging = target + ".new-" + Guid.NewGuid().ToString("N");
        string backup = target + ".old-" + Guid.NewGuid().ToString("N");
        try
        {
            ExtractPayload(staging);
            EnsureWebViewRuntime(staging);
            ConfigureLibrary(staging, data, testing ? Path.Combine(Path.GetDirectoryName(data), "documents") : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments));
            if (Directory.Exists(target)) Directory.Move(target, backup);
            try
            {
                Directory.Move(staging, target);
                if (!testing) Register(target);
            }
            catch
            {
                if (Directory.Exists(target)) Directory.Delete(target, true);
                if (Directory.Exists(backup)) Directory.Move(backup, target);
                throw;
            }
            if (Directory.Exists(backup)) Directory.Delete(backup, true);
        }
        finally
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
        }
    }

    private static bool HasRecentWebViewRuntime()
    {
        const string key = @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
        foreach (RegistryHive hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
        foreach (RegistryView view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
        {
            using (var root = RegistryKey.OpenBaseKey(hive, view))
            using (var installed = root.OpenSubKey(key))
            {
                Version version;
                if (installed != null && Version.TryParse(installed.GetValue("pv") as string, out version) &&
                    version.Major >= 140) return true;
            }
        }
        return false;
    }

    private static void EnsureWebViewRuntime(string staging)
    {
        string installer = Path.Combine(staging, "MicrosoftEdgeWebView2RuntimeInstallerX64.exe");
        if (!File.Exists(installer))
        {
            if (!HasRecentWebViewRuntime())
                throw new InvalidOperationException("这台电脑需要更新 WebView2。请下载包含运行时的 ParallelReader-Offline-Setup-x64.exe。");
            return;
        }
        if (!HasRecentWebViewRuntime())
        {
            var start = new ProcessStartInfo(installer, "/silent /install") {
                WorkingDirectory = staging, UseShellExecute = false, CreateNoWindow = true
            };
            int code;
            using (var setup = Process.Start(start)) { setup.WaitForExit(); code = setup.ExitCode; }
            // Edge Update can complete registration in another process.
            for (int attempt = 0; attempt < 60 && !HasRecentWebViewRuntime(); attempt++)
                Thread.Sleep(500);
            if (!HasRecentWebViewRuntime())
                throw new InvalidOperationException("WebView2 离线安装未完成（代码 0x" + code.ToString("X8") +
                    "）。请检查设备的软件安装策略，或重启后再次运行此安装包。");
        }
        // Edge Update may still have its installer open just after registering.
        for (int attempt = 0; ; attempt++)
        {
            try { File.Delete(installer); break; }
            catch (IOException) { if (attempt >= 30) throw; Thread.Sleep(500); }
        }
    }

    private static void ConfigureLibrary(string staging, string data, string documents)
    {
        string setting = Path.Combine(data, "library-location.txt");
        string source = Path.Combine(staging, "source-library.txt");
        string library = Path.Combine(data, "library");
        if (File.Exists(setting)) return;
        if (!Directory.Exists(library) && File.Exists(source))
        {
            string candidate = Path.Combine(documents, File.ReadAllText(source).Trim());
            if (Directory.Exists(candidate)) library = candidate;
        }
        Directory.CreateDirectory(library);
        File.WriteAllText(setting, library + Environment.NewLine);
    }

    private static void ExtractPayload(string staging)
    {
        string temporaryZip = Path.GetTempFileName();
        try
        {
            using (var exe = File.OpenRead(Application.ExecutablePath))
            using (var reader = new BinaryReader(exe))
            {
                exe.Seek(-16, SeekOrigin.End);
                long bytes = reader.ReadInt64();
                if (reader.ReadInt64() != PayloadMarker || bytes <= 0 || bytes > exe.Length - 16)
                    throw new InvalidDataException("安装包内容不完整。");
                exe.Seek(-16 - bytes, SeekOrigin.End);
                using (var archive = File.Create(temporaryZip))
                {
                    var buffer = new byte[128 * 1024];
                    while (bytes > 0)
                    {
                        int read = exe.Read(buffer, 0, (int)Math.Min(bytes, buffer.Length));
                        if (read == 0) throw new EndOfStreamException();
                        archive.Write(buffer, 0, read);
                        bytes -= read;
                    }
                }
            }
            ZipFile.ExtractToDirectory(temporaryZip, staging);
        }
        finally { File.Delete(temporaryZip); }
    }

    private static void Register(string target)
    {
        string app = Path.Combine(target, "ParallelReader.exe");
        string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs, Environment.SpecialFolderOption.Create);
        string shortcutPath = Path.Combine(programs, AppName + ".lnk");
        Directory.CreateDirectory(programs);
        var shortcut = (IShellLinkW)new ShellLink();
        try
        {
            shortcut.SetPath(app);
            shortcut.SetWorkingDirectory(target);
            shortcut.SetDescription(AppName);
            ((IPersistFile)shortcut).Save(shortcutPath, true);
        }
        finally { Marshal.FinalReleaseComObject(shortcut); }

        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            key.SetValue("DisplayName", AppName);
            key.SetValue("DisplayIcon", app);
            key.SetValue("InstallLocation", target);
            key.SetValue("UninstallString", "\"" + powershell + "\" -NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(target, "uninstall.ps1") + "\"");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    // IShellLinkW uses Unicode paths independently of the Windows system locale.
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, IntPtr findData, uint flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int size);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int size);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int size);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int show);
        void SetShowCmd(int show);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }
}
