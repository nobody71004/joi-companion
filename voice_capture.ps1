#Requires -Version 5.1
<#
  JOI voice input — ONE-SHOT offline capture (no Google/cloud needed).
  Records the default mic for -Seconds seconds, transcribes offline with
  Windows System.Speech (DictationGrammar), and writes the result JSON to
  -OutJson. Exits when done. Spawned by the server's POST /api/voice.

  Param  -Seconds  recording window in seconds (default 4, max 10)
         -OutJson  path to write {"ok":true,"text":"..."} or {"ok":false,"error":"..."}
#>
param([int]$Seconds = 4, [string]$OutJson = "")

$ErrorActionPreference = "Stop"
if ($Seconds -lt 1) { $Seconds = 1 }
if ($Seconds -gt 10) { $Seconds = 10 }
if (-not $OutJson) { $OutJson = Join-Path $env:TEMP ("joi_voice_" + [guid]::NewGuid().ToString("N") + ".json") }

Add-Type -ReferencedAssemblies "System.Speech" -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace JoiVoice
{
    public static class Capture
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct WAVEFORMATEX
        {
            public ushort wFormatTag; public ushort nChannels;
            public uint nSamplesPerSec; public uint nAvgBytesPerSec;
            public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct WAVEHDR
        {
            public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded;
            public IntPtr dwUser; public uint dwFlags; public uint dwLoops;
            public IntPtr lpNext; public IntPtr reserved;
        }

        [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint dev, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, uint flags);
        [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, int size);
        [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, int size);
        [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, int size);
        [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
        [DllImport("winmm.dll")] static extern int waveInStop(IntPtr h);
        [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);

        const uint WHDR_DONE = 1;
        const uint WAVE_MAPPER = 0xFFFFFFFF;
        const int CHUNK_BYTES = 1280;          // 40ms @ 16kHz mono s16
        const int NUM_BUFS = 8;

        static readonly int OffBytesRecorded = (int)Marshal.OffsetOf(typeof(WAVEHDR), "dwBytesRecorded");
        static readonly int OffFlags = (int)Marshal.OffsetOf(typeof(WAVEHDR), "dwFlags");
        static readonly int OffBufferLength = (int)Marshal.OffsetOf(typeof(WAVEHDR), "dwBufferLength");

        static IntPtr StartCapture(out IntPtr[] bufs, out IntPtr[] hdrs)
        {
            WAVEFORMATEX fmt = new WAVEFORMATEX();
            fmt.wFormatTag = 1; fmt.nChannels = 1; fmt.nSamplesPerSec = 16000;
            fmt.wBitsPerSample = 16; fmt.nBlockAlign = 2; fmt.nAvgBytesPerSec = 32000; fmt.cbSize = 0;
            IntPtr h;
            if (waveInOpen(out h, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0) != 0)
            { bufs = null; hdrs = null; return IntPtr.Zero; }
            int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
            bufs = new IntPtr[NUM_BUFS]; hdrs = new IntPtr[NUM_BUFS];
            for (int i = 0; i < NUM_BUFS; i++)
            {
                bufs[i] = Marshal.AllocHGlobal(CHUNK_BYTES);
                hdrs[i] = AllocHeader(bufs[i], CHUNK_BYTES);
                waveInPrepareHeader(h, hdrs[i], hdrSize);
                waveInAddBuffer(h, hdrs[i], hdrSize);
            }
            waveInStart(h);
            return h;
        }

        static void DrainBuffers(IntPtr hIn, IntPtr[] bufs, IntPtr[] hdrs, MemoryStream pcm)
        {
            int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
            for (int i = 0; i < NUM_BUFS; i++)
            {
                if ((ReadHdrFlags(hdrs[i]) & WHDR_DONE) == 0) continue;
                int n = ReadHdrRecorded(hdrs[i]);
                if (n > 0 && pcm != null)
                {
                    byte[] tmp = new byte[n];
                    Marshal.Copy(bufs[i], tmp, 0, n);
                    pcm.Write(tmp, 0, n);
                }
                waveInUnprepareHeader(hIn, hdrs[i], hdrSize);
                Marshal.WriteInt32(hdrs[i], OffBytesRecorded, 0);
                Marshal.WriteInt32(hdrs[i], OffFlags, 0);
                Marshal.WriteIntPtr(hdrs[i], 0, bufs[i]);
                Marshal.WriteInt32(hdrs[i], OffBufferLength, CHUNK_BYTES);
                waveInPrepareHeader(hIn, hdrs[i], hdrSize);
                waveInAddBuffer(hIn, hdrs[i], hdrSize);
            }
        }

        static void StopCapture(IntPtr hIn, IntPtr[] bufs, IntPtr[] hdrs)
        {
            if (hIn == IntPtr.Zero) return;
            int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
            try { waveInStop(hIn); } catch { }
            for (int i = 0; i < NUM_BUFS; i++)
            {
                try { waveInUnprepareHeader(hIn, hdrs[i], hdrSize); } catch { }
                if (hdrs[i] != IntPtr.Zero) Marshal.FreeHGlobal(hdrs[i]);
                if (bufs[i] != IntPtr.Zero) Marshal.FreeHGlobal(bufs[i]);
            }
            waveInClose(hIn);
        }

        static IntPtr AllocHeader(IntPtr data, int bytes)
        {
            IntPtr hdrPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEHDR)));
            WAVEHDR hdr = new WAVEHDR();
            hdr.lpData = data; hdr.dwBufferLength = (uint)bytes; hdr.dwBytesRecorded = 0;
            hdr.dwFlags = 0; hdr.dwLoops = 0;
            Marshal.StructureToPtr(hdr, hdrPtr, false);
            return hdrPtr;
        }

        static uint ReadHdrFlags(IntPtr hdrPtr) { return (uint)Marshal.ReadInt32(hdrPtr, OffFlags); }
        static int ReadHdrRecorded(IntPtr hdrPtr) { return Marshal.ReadInt32(hdrPtr, OffBytesRecorded); }

        static void WriteWav(string path, MemoryStream pcm)
        {
            byte[] data = pcm.ToArray();
            using (FileStream fs = new FileStream(path, FileMode.Create))
            using (BinaryWriter w = new BinaryWriter(fs))
            {
                w.Write(Encoding.ASCII.GetBytes("RIFF"));
                w.Write(36 + data.Length);
                w.Write(Encoding.ASCII.GetBytes("WAVE"));
                w.Write(Encoding.ASCII.GetBytes("fmt "));
                w.Write(16);
                w.Write((ushort)1);          // PCM
                w.Write((ushort)1);          // mono
                w.Write(16000);
                w.Write(32000);
                w.Write((ushort)2);
                w.Write((ushort)16);
                w.Write(Encoding.ASCII.GetBytes("data"));
                w.Write(data.Length);
                w.Write(data);
            }
        }

        static string RecognizeFile(string wav)
        {
            try
            {
                using (System.Speech.Recognition.SpeechRecognitionEngine engine =
                    new System.Speech.Recognition.SpeechRecognitionEngine(new System.Globalization.CultureInfo("en-US")))
                {
                    engine.LoadGrammar(new System.Speech.Recognition.DictationGrammar());
                    engine.SetInputToWaveFile(wav);
                    System.Speech.Recognition.RecognitionResult res = engine.Recognize();
                    return res == null ? "" : res.Text;
                }
            }
            catch { return ""; }
        }

        public static string Run(int seconds)
        {
            MemoryStream pcm = new MemoryStream();
            IntPtr hIn;
            IntPtr[] bufs, hdrs;
            hIn = StartCapture(out bufs, out hdrs);
            if (hIn == IntPtr.Zero) return "{\"ok\":false,\"error\":\"no input device\"}";
            DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
            while (DateTime.UtcNow < deadline)
            {
                DrainBuffers(hIn, bufs, hdrs, pcm);
                Thread.Sleep(20);
            }
            DrainBuffers(hIn, bufs, hdrs, pcm);
            StopCapture(hIn, bufs, hdrs);
            string wav = Path.Combine(Path.GetTempPath(), "joi_voice_last.wav");
            try { WriteWav(wav, pcm); } catch { return "{\"ok\":false,\"error\":\"write wav\"}"; }
            string text = RecognizeFile(wav);
            try { if (File.Exists(wav)) File.Delete(wav); } catch { }
            return "{\"ok\":true,\"text\":" + JsonEscape(text) + "}";
        }

        static string JsonEscape(string s)
        {
            if (s == null) return "\"\"";
            StringBuilder sb = new StringBuilder();
            foreach (char ch in s)
            {
                switch (ch)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default: sb.Append(ch); break;
                }
            }
            return "\"" + sb.ToString() + "\"";
        }
    }
}
"@

try {
    $json = [JoiVoice.Capture]::Run($Seconds)
    Set-Content -Path $OutJson -Value $json -Encoding UTF8
    Write-Output ("[joi] voice: " + $json)
}
catch {
    $errObj = @{ ok = $false; error = $_.Exception.Message }
    $err = $errObj | ConvertTo-Json -Compress
    try { Set-Content -Path $OutJson -Value $err -Encoding UTF8 } catch { }
    Write-Output ("[joi] voice error: " + $err)
    exit 1
}
