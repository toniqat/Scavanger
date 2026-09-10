// SCAVANGER 배포본의 **stub 런처** — 받는 사람이 누르는 그 exe 다.
//
// 배포 폴더에는 사람이 볼 것만 둔다는 결정(2026-09-10) 때문에 실제 빌드(electron 런타임 · .pak · dll 수백 개)는
// `app\` 안으로 내렸다. 이 exe 는 그 안의 `app\SCAVANGER.exe` 를 띄우는 것 하나만 한다 — 게임 코드도, 설정도,
// 업데이트 로직도 여기 없다. 아이콘은 컴파일할 때 `/win32icon` 으로 같은 icon.ico 를 박으므로 사용자에게는
// 하나의 SCAVANGER.exe 로 보인다.
//
// `scripts/pack-release.mjs` 가 Windows 에 항상 있는 .NET Framework 컴파일러(csc.exe)로 이 파일을 굽는다.
// GUI 앱(`/target:winexe`)이라 콘솔 창이 깜빡이지 않는다.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

// 탐색기 속성 · 작업 관리자에 보이는 이름. csc 가 이 attribute 들로 Win32 버전 리소스를 만들어 준다 —
// 없으면 SCAVANGER.exe 의 설명이 빈칸으로 뜬다. 버전은 package.json 과 손으로 맞춘다(빌드가 읽지 않는다).
[assembly: AssemblyTitle("SCAVANGER")]
[assembly: AssemblyProduct("SCAVANGER")]
[assembly: AssemblyDescription("SCAVANGER 실행")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

static class Launcher
{
    [STAThread]
    static int Main(string[] args)
    {
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string appDir = Path.Combine(root, "app");
        string exe = Path.Combine(appDir, "SCAVANGER.exe");

        if (!File.Exists(exe))
        {
            MessageBox.Show(
                "게임 파일을 찾을 수 없습니다:\n" + exe +
                "\n\n이 파일은 app 폴더와 같은 자리에 있어야 합니다.\n" +
                "압축을 풀 때 폴더 구조가 유지되었는지 확인하세요.",
                "SCAVANGER", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        // 넘어온 인자를 그대로 전달한다 (--local · --devtools · --relay=… 진단용).
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(args[i].IndexOf(' ') >= 0 ? "\"" + args[i] + "\"" : args[i]);
        }

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(exe, sb.ToString());
            // 작업 폴더는 **배포 폴더**다 — 앱이 server.txt 를 찾는 후보 중 하나다 (electron/main.ts configDirs).
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            Process.Start(psi);
        }
        catch (Exception e)
        {
            MessageBox.Show("게임을 실행하지 못했습니다.\n\n" + e.Message,
                "SCAVANGER", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }
}
