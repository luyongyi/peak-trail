using System;
using System.Globalization;

namespace PeakTrailRecorder;

internal static class SessionIdentity
{
    public static string Create(DateTimeOffset startedAt, Guid nonce)
    {
        if (nonce == Guid.Empty)
        {
            throw new ArgumentException("A non-empty session nonce is required.", nameof(nonce));
        }

        // RunId deliberately is not part of uniqueness. A crash, reconnect or plugin rebuild can
        // create multiple monotonic streams for one game run; each needs its own journal key.
        return startedAt.UtcDateTime.ToString("yyyyMMdd'T'HHmmss.fffffff'Z'", CultureInfo.InvariantCulture)
            + "-" + nonce.ToString("N");
    }
}
