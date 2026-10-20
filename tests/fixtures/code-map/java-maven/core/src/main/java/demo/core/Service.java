package demo.core;
public class Service extends Base implements Contract {
  public Service() {}
  public void save(int value) { log(value); this.local(); super.note(); }
  private void local() {}
}
