using System;
using System.Security.Cryptography;
using System.Text;
using PhotonPlayer = Photon.Realtime.Player;

namespace PeakTrailRecorder;

internal static class IdentityResolver
{
    /// <summary>
    /// Resolves a stable multiplayer identity. This intentionally stores the raw Photon/platform
    /// identifier requested by the project; it is personally identifying telemetry and must never
    /// be uploaded or shared without every recorded player's consent.
    /// </summary>
    public static PlayerIdentity FromCharacter(Character character)
    {
        PhotonPlayer owner = character.photonView.Owner;
        return Resolve(owner, character);
    }

    public static PlayerIdentity FromPhotonPlayer(PhotonPlayer player)
    {
        Character? character = null;
        try
        {
            PlayerHandler.TryGetCharacter(player.ActorNumber, out character);
        }
        catch
        {
            // The Photon player often arrives before its Character has spawned.
        }

        return Resolve(player, character);
    }

    private static PlayerIdentity Resolve(PhotonPlayer owner, Character? character)
    {
        string nickname = owner.NickName ?? string.Empty;
        string platform = ReadProperty(owner, "PlatformFamily");
        if (string.IsNullOrWhiteSpace(platform) && character?.data != null)
        {
            platform = character.data.platformFamily.ToString();
        }
        if (string.IsNullOrWhiteSpace(platform))
        {
            platform = "unknown";
        }

        string playerId = owner.UserId ?? string.Empty;
        string idSource = "photon-user-id";

        if (string.IsNullOrWhiteSpace(playerId))
        {
            playerId = ReadProperty(owner, "ProductUserID");
            idSource = "product-user-id";
        }
        if (string.IsNullOrWhiteSpace(playerId))
        {
            playerId = ReadProperty(owner, "UserID");
            idSource = "platform-user-id";
        }
        if (string.IsNullOrWhiteSpace(playerId) && !string.IsNullOrWhiteSpace(character?.data?.productUserID))
        {
            playerId = character.data.productUserID;
            idSource = "character-product-user-id";
        }
        if (string.IsNullOrWhiteSpace(playerId) && character?.data != null && character.data.userID != 0)
        {
            playerId = character.data.userID.ToString();
            idSource = "character-platform-user-id";
        }
        if (string.IsNullOrWhiteSpace(playerId))
        {
            // This remains stable for the same platform/nickname combination and is not random.
            // It cannot guarantee cross-run identity if a player changes nickname and the network
            // supplies no real account ID, so idSource is retained for diagnostics.
            playerId = "fallback-sha256:" + StableHash(platform + "\n" + nickname);
            idSource = "platform-nickname-hash";
        }

        return new PlayerIdentity
        {
            PlayerId = playerId,
            Nickname = nickname,
            ActorNumber = owner.ActorNumber,
            Platform = platform,
            IdSource = idSource,
        };
    }

    private static string ReadProperty(PhotonPlayer player, string key)
    {
        try
        {
            object? value = player.CustomProperties?[key];
            return value?.ToString() ?? string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string StableHash(string value)
    {
        using SHA256 sha = SHA256.Create();
        byte[] bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(value));
        var builder = new StringBuilder(24);
        for (int i = 0; i < 12; i++)
        {
            builder.Append(bytes[i].ToString("x2"));
        }
        return builder.ToString();
    }
}
