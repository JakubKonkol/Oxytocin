namespace Contoso.Core.Services
{
    public abstract class RepositoryBase
    {
        protected void Log(string message) => Logger.Write(message);
    }

    internal static class Logger
    {
        public static void Write(string message) { }
    }
}
