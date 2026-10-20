using Contoso.Core.Models;

namespace Contoso.Core.Extensions;

public static class OrderExtensions
{
    public static bool IsNew(this Order order) => order.Id == 0;

#if DEBUG
    public static string Describe(Order order) => "debug";
#else
    public static string Describe(Order order) => "release";
#endif
}
