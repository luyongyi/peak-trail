using System;
using System.Net.Http;

namespace PeakTrailRecorder;

/// <summary>Validated relay transport settings, independent of Unity/game state.</summary>
internal sealed class LiveRelayConnection
{
    public const string DefaultServerUrl = "https://peak.mylus.cn";

    public string ServerUrl { get; }

    public LiveRelayConnection(string serverUrl)
    {
        // Fixed error strings: never place a supplied URL or credential in an exception.
        string url = serverUrl?.Trim() ?? "";
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || string.IsNullOrEmpty(uri.Host)
            || uri.GetLeftPart(UriPartial.Authority).Contains('@')
            || url.Contains('?') || url.Contains('#'))
        {
            throw new ArgumentException("Live ServerUrl must be an absolute HTTP(S) URL without user information, query or fragment.");
        }

        ServerUrl = uri.AbsoluteUri.TrimEnd('/');
    }

    public HttpClient CreateHttpClient(TimeSpan timeout)
    {
        // Do not follow a relay redirect to an unexpected host or downgrade HTTPS.
        return new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        {
            BaseAddress = new Uri(ServerUrl + "/"),
            Timeout = timeout,
        };
    }
}
