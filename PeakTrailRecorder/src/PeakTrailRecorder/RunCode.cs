using System;
using System.Security.Cryptography;
using System.Text;

namespace PeakTrailRecorder;

/// <summary>
/// Deterministic 4-character run code, byte-for-byte identical to the server's
/// reference implementation (PeakTrailPlatform/server/run-code.mjs). Every modded
/// client in the same PEAK run derives the SAME code from the room-shared
/// RunManager.RunId, so the relay can merge all their uploads into one run
/// without any client-side coordination.
/// </summary>
internal static class RunCode
{
    public const string Alphabet = "23456789abcdefghjkmnpqrstuvwxyz"; // no 0/o/1/i/l — 31 chars
    public const int Length = 4;
    public const int MaxDerivationAttempts = 8;
    private static readonly uint CodeSpace = (uint)Math.Pow(Alphabet.Length, Length); // 923521

    public static string Normalize(string? runId)
    {
        string text = (runId ?? string.Empty).Trim().ToLowerInvariant();
        if (text.Length >= 2 && ((text[0] == '{' && text[^1] == '}') || (text[0] == '[' && text[^1] == ']')))
        {
            text = text[1..^1];
        }
        if (Guid.TryParse(text, out Guid guid)) return guid.ToString("D");
        string compact = text.Replace("-", string.Empty, StringComparison.Ordinal);
        if (compact.Length == 32 && IsHex(compact))
        {
            return $"{compact[..8]}-{compact.Substring(8, 4)}-{compact.Substring(12, 4)}-{compact.Substring(16, 4)}-{compact.Substring(20)}";
        }
        return text;
    }

    /// <summary>First code for this run; <paramref name="attempt"/> walks a
    /// deterministic fallback sequence when the server reports a code collision.</summary>
    public static string Derive(string? runId, int attempt = 0)
    {
        string normalized = Normalize(runId);
        if (normalized.Length == 0) return string.Empty;
        byte[] digest;
        // SHA256.HashData (.NET 6+) is unavailable on netstandard2.1, which this
        // file must also compile against for the game plugin.
#pragma warning disable CA1850
        using (SHA256 sha = SHA256.Create())
        {
            digest = sha.ComputeHash(Encoding.UTF8.GetBytes($"{normalized}:{attempt}"));
        }
#pragma warning restore CA1850
        // Explicit little-endian u32; must match the JS `>>> 0` reinterpretation.
        uint value = digest[0] | (uint)digest[1] << 8 | (uint)digest[2] << 16 | (uint)digest[3] << 24;
        uint rest = value % CodeSpace;
        Span<char> chars = stackalloc char[Length];
        for (int index = Length - 1; index >= 0; index--)
        {
            chars[index] = Alphabet[(int)(rest % (uint)Alphabet.Length)];
            rest /= (uint)Alphabet.Length;
        }
        return new string(chars);
    }

    /// <summary>The server "confirms" a code by re-deriving it from the runId.</summary>
    public static bool Matches(string? runId, string? code)
    {
        if (string.IsNullOrEmpty(code) || code.Length != Length) return false;
        for (int attempt = 0; attempt < MaxDerivationAttempts; attempt++)
        {
            if (string.Equals(Derive(runId, attempt), code, StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private static bool IsHex(string text)
    {
        foreach (char character in text)
        {
            bool hex = character is >= '0' and <= '9' or >= 'a' and <= 'f';
            if (!hex) return false;
        }
        return true;
    }
}
