namespace Contoso.Core.Services
{
    using Contoso.Core.Models;

    public class OrderRepository : RepositoryBase, IRepository<Order>
    {
        private readonly List<Order> items = new();

        public void Save(Order order)
        {
            if (order.Validate())
                items.Add(order);
            Log("saved");
        }

        public void Save(Order order, bool flush)
        {
            Save(order);
            order.Process(flush);
        }

        public Order? Find(int id)
        {
            var order = new Order(id);
            order.Process(true);
            return order;
        }
    }
}
