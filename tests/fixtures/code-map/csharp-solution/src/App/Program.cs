using Contoso.App;
using Contoso.Core.Extensions;
using Contoso.Core.Services;

var repository = new OrderRepository();
var order = new Order(1);
repository.Save(order);
repository.Save(order, true);
if (order.IsNew())
    Console.WriteLine(OrderExtensions.Describe(order));
Startup.Configure();
