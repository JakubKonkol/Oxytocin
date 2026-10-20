namespace Contoso.Core.Models;

public partial class Order
{
    public Order(int id) => Id = id;

    public int Id { get; init; }

    public void Process() { }

    public void Process(bool flush) { }
}
