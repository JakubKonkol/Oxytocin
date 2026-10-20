package demo.app;
import demo.core.Service;
import demo.core.*;
import static demo.core.Tools.notify;
import static demo.core.Tools.*;

public class Main {
  private Service service;
  public Main(Service service) { this.service = service; }
  public void run(Service arg, Object unknown) {
    arg.save(1);
    service.save(2);
    var local = new Service();
    local.save(3);
    local.save(3, 4);
    notify(1);
    same(1);
    unknown.save(1);
    java.util.Collections.emptyList();
  }
}
