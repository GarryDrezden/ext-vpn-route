using System.Reflection;

namespace VpnRoute.NativeHost;

internal static class ProductHostVersion
{
    public static string Display { get; } = BuildDisplay();

    private static string BuildDisplay()
    {
        Assembly assembly = typeof(ProductHostVersion).Assembly;
        string? informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            int plus = informational.IndexOf('+');
            string trimmed = (plus >= 0 ? informational[..plus] : informational).Trim();
            if (trimmed.Length > 0)
            {
                return trimmed;
            }
        }

        Version? version = assembly.GetName().Version;
        if (version is null)
        {
            return "0.0.0";
        }

        if (version.Revision > 0)
        {
            return $"{version.Major}.{version.Minor}.{version.Build} RC{version.Revision}";
        }

        return version.ToString(3);
    }
}
