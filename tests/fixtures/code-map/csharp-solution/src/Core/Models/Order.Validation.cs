namespace Contoso.Core.Models;

partial class Order
{
    public bool Validate()
    {
        Process();
        return Id > 0;
    }
}
