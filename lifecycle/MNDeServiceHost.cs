using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

public sealed class MNDeServiceHost : ServiceBase
{
    private Process child;
    private Thread monitor;
    private volatile bool stopping;
    private HostConfig config;

    public MNDeServiceHost()
    {
        ServiceName = "MNDeCustody";
        CanStop = true;
        AutoLog = true;
    }

    protected override void OnStart(string[] args)
    {
        config = HostConfig.Load(AppContext.BaseDirectory);
        Directory.CreateDirectory(Path.GetDirectoryName(config.runtime_log));
        stopping = false;
        StartChild();
        monitor = new Thread(MonitorChild);
        monitor.IsBackground = true;
        monitor.Start();
    }

    protected override void OnStop()
    {
        stopping = true;
        StopChild();
    }

    private void StartChild()
    {
        var info = new ProcessStartInfo();
        info.FileName = config.node_path;
        info.Arguments = "\"" + config.cli_path + "\" custody --config \"" + config.config_path + "\"";
        info.WorkingDirectory = config.working_directory;
        info.UseShellExecute = false;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.CreateNoWindow = true;
        child = new Process();
        child.StartInfo = info;
        child.OutputDataReceived += (sender, eventArgs) => { if (eventArgs.Data != null) AppendLog(eventArgs.Data); };
        child.ErrorDataReceived += (sender, eventArgs) => { if (eventArgs.Data != null) AppendLog(eventArgs.Data); };
        child.Start();
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();
    }

    private void MonitorChild()
    {
        while (!stopping)
        {
            child.WaitForExit();
            var exitCode = child.ExitCode;
            AppendLog("{\"event\":\"mnde.service.child_exit\",\"exit_code\":" + exitCode + "}");
            if (stopping || exitCode == 2)
            {
                Stop();
                return;
            }
            Thread.Sleep(3000);
            if (!stopping)
            {
                StartChild();
            }
        }
    }

    private void StopChild()
    {
        try
        {
            if (child != null && !child.HasExited)
            {
                child.Kill();
                child.WaitForExit(10000);
            }
        }
        catch {}
    }

    private void AppendLog(string line)
    {
        try
        {
            File.AppendAllText(config.runtime_log, line + Environment.NewLine);
        }
        catch {}
    }

    public static void Main()
    {
        Run(new MNDeServiceHost());
    }

    private sealed class HostConfig
    {
        public string node_path { get; set; }
        public string cli_path { get; set; }
        public string config_path { get; set; }
        public string working_directory { get; set; }
        public string runtime_log { get; set; }

        public static HostConfig Load(string baseDir)
        {
            var path = Path.Combine(baseDir, "service-host.env");
            var cfg = new HostConfig();
            foreach (var line in File.ReadAllLines(path))
            {
                if (line.StartsWith("node_path=")) cfg.node_path = line.Substring("node_path=".Length);
                if (line.StartsWith("cli_path=")) cfg.cli_path = line.Substring("cli_path=".Length);
                if (line.StartsWith("config_path=")) cfg.config_path = line.Substring("config_path=".Length);
                if (line.StartsWith("working_directory=")) cfg.working_directory = line.Substring("working_directory=".Length);
                if (line.StartsWith("runtime_log=")) cfg.runtime_log = line.Substring("runtime_log=".Length);
            }
            return cfg;
        }
    }
}
