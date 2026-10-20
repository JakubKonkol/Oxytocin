namespace Contoso.App;

internal static class Startup
{
    public static void Configure()
    {
        var cache = new Cache<Order>();
        cache.Put(null);
        Contoso.Core.Abstractions.IRepository<Order> repository = null!;
    }
}

public class Cache<T> where T : class
{
    public void Put(T? value) { }
}
