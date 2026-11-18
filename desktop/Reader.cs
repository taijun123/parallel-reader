using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32.SafeHandles;

internal sealed class Reader : Form
{
    private const string AppName = "对读 PDF 阅读器";
    private readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill };
    private readonly Label state = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Text = "正在打开对读…" };
    private Process server;
    private ChildJob job;

    private Reader()
    {
        Text = AppName;
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1320, 880);
        MinimumSize = new Size(720, 480);
        Controls.Add(view);
        Controls.Add(state);
        state.BringToFront();
    }

    internal static string TestRoot { get { return Environment.GetEnvironmentVariable("PARALLEL_READER_TEST_ROOT"); } }
    internal static string DataRoot
    {
        get { return String.IsNullOrEmpty(TestRoot) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ParallelReader") : Path.Combine(TestRoot, "data"); }
    }
    internal static string MutexName { get { return @"Local\ParallelReader-" + (String.IsNullOrEmpty(TestRoot) ? Environment.UserName : TestRoot.GetHashCode().ToString("X8")); } }

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var mutex = new Mutex(false, MutexName))
        {
            bool acquired;
            try { acquired = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired)
            {
                IntPtr window = FindWindow(null, AppName);
                if (window != IntPtr.Zero)
                {
                    ShowWindow(window, 9);
                    SetForegroundWindow(window);
                }
                return;
            }
            try { using (var reader = new Reader()) Application.Run(reader); }
            finally { mutex.ReleaseMutex(); }
        }
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        try
        {
            string profile = Path.Combine(DataRoot, "WebView2");
            var options = new CoreWebView2EnvironmentOptions("--disable-background-networking");
            var environment = await CoreWebView2Environment.CreateAsync(null, profile, options);
            if (IsDisposed) return;
            await view.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;
            job = new ChildJob();
            var url = new Uri(await StartServer());
            if (IsDisposed) return;
            CoreWebView2 core = view.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.NavigationStarting += (sender, args) => { args.Cancel = !IsLocal(args.Uri, url); };
            core.NewWindowRequested += (sender, args) => { args.Handled = true; };
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
            core.WebResourceRequested += (sender, args) =>
            {
                string request = args.Request.Uri;
                if (!IsLocal(request, url) && !request.StartsWith("data:", StringComparison.OrdinalIgnoreCase) &&
                    !request.StartsWith("blob:" + url.GetLeftPart(UriPartial.Authority) + "/", StringComparison.OrdinalIgnoreCase))
                {
                    args.Response = environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
                }
            };
            core.NavigationCompleted += (sender, args) =>
            {
                if (args.IsSuccess) state.Hide();
                else state.Text = "页面加载失败，请关闭窗口后重新打开。";
            };
            core.Navigate(url.AbsoluteUri);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            state.Text = "缺少 Microsoft Edge WebView2 Runtime。安装该运行时后重新打开对读。";
        }
        catch (Exception error)
        {
            if (IsDisposed) return;
            StopServer();
            state.Text = "打开失败。\r\n" + error.Message;
        }
    }

    private static bool IsLocal(string address, Uri root)
    {
        Uri parsed;
        return Uri.TryCreate(address, UriKind.Absolute, out parsed) && parsed.Scheme == root.Scheme &&
            parsed.Host == root.Host && parsed.Port == root.Port;
    }

    private async Task<string> StartServer()
    {
        string app = AppDomain.CurrentDomain.BaseDirectory;
        string library = Environment.GetEnvironmentVariable("LIBRARY_DIR");
        if (String.IsNullOrWhiteSpace(library))
        {
            string configured = Path.Combine(DataRoot, "library-location.txt");
            string candidate = File.Exists(configured) ? File.ReadAllText(configured).Trim() : "";
            library = candidate.Length > 0 ? candidate : Path.Combine(DataRoot, "library");
        }
        Directory.CreateDirectory(library);
        foreach (int port in new[] { 49373, 49374, 49375, 49376, 49377 })
        {
            var start = new ProcessStartInfo(Path.Combine(app, "node.exe"), "server.mjs")
            {
                WorkingDirectory = app,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.EnvironmentVariables["PORT"] = port.ToString();
            start.EnvironmentVariables["LIBRARY_DIR"] = library;
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var child = new Process { StartInfo = start, EnableRaisingEvents = true };
            var uri = new UriBuilder("http", "127.0.0.1", port).Uri;
            string message = "Parallel Reader is ready: " + uri.GetLeftPart(UriPartial.Authority);
            child.OutputDataReceived += (sender, args) => { if (args.Data != null && args.Data.StartsWith(message, StringComparison.Ordinal)) ready.TrySetResult(true); };
            child.ErrorDataReceived += (sender, args) => { if (args.Data != null) Debug.WriteLine(args.Data); };
            child.Exited += (sender, args) => { ready.TrySetResult(false); };
            server = child;
            child.Start();
            job.Add(child);
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            if (await Task.WhenAny(ready.Task, Task.Delay(7000)) == ready.Task && await ready.Task)
                return uri.AbsoluteUri;
            if (IsDisposed) throw new ObjectDisposedException("Reader");
            StopServer();
        }
        throw new InvalidOperationException("本地阅读服务启动失败。");
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        StopServer();
        if (job != null) job.Dispose();
        base.OnFormClosed(e);
    }

    private void StopServer()
    {
        if (server == null) return;
        try { if (!server.HasExited) server.Kill(); }
        catch (InvalidOperationException) { }
        server.Dispose();
        server = null;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string className, string windowName);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);

    private sealed class ChildJob : IDisposable
    {
        private readonly SafeFileHandle handle = CreateJobObject(IntPtr.Zero, null);

        internal ChildJob()
        {
            var limits = new JobLimits();
            limits.Basic.LimitFlags = 0x2000;
            if (handle.IsInvalid || !SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))))
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new System.ComponentModel.Win32Exception(error);
            }
        }

        internal void Add(Process process)
        {
            if (!AssignProcessToJobObject(handle, process.Handle) && !process.HasExited)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }

        public void Dispose() { handle.Dispose(); }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobLimits
        {
            public BasicLimits Basic;
            public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, int type, ref JobLimits info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    }
}
