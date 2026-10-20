using Contoso.Core.Models;
using Xunit;

namespace Contoso.Core.Tests;

public class OrderTests
{
    [Fact]
    public void ValidatesPositiveIds()
    {
        var order = new Order(3);
        Assert.True(order.Validate());
    }
}
