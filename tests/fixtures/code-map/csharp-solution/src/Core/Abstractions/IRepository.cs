namespace Contoso.Core.Abstractions;

/// <summary>Stores items. Comments are never copied into the map.</summary>
public interface IRepository<T>
{
    void Save(T item);
    T? Find(int id);
}
