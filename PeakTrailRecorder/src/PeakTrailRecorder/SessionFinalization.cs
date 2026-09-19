using System;

namespace PeakTrailRecorder;

/// <summary>Preserve terminal observations before closing an append-only session.
/// RPCA_Die can synchronously raise RunEnded before its CharacterDied callback.</summary>
internal static class SessionFinalization
{
    public static void Run(Action captureFinalState, Action finish, Action<Exception> reportCaptureError)
    {
        try
        {
            captureFinalState();
        }
        catch (Exception exception)
        {
            // Scene teardown can invalidate a Unity object mid-read. Failure to take one
            // final snapshot must never prevent recovery/finalization of existing records.
            reportCaptureError(exception);
        }
        finally
        {
            finish();
        }
    }
}
