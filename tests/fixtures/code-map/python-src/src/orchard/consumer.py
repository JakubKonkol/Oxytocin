import orchard as api
import orchard.util
import importlib
from . import service as svc
from .service import Service
from .util import *
from ns.tool import work

try:
    from .fast import choose
except ImportError:
    from .slow import choose

def use(dynamic):
    api.run()
    orchard.util.calculate()
    svc.run()
    Service()
    Service.static()
    calculate()
    temporary = Service()
    temporary.method()
    dynamic.method()
    importlib.import_module("orchard.extra")
    _hidden()
    choose()
    work()
