from .base import Base
from .util import calculate

class Service(Base):
    def method(self):
        return calculate()

    def inherited(self):
        return self.base()

    @staticmethod
    def static():
        return calculate()

def run():
    return calculate()

__all__ = ["Service", "run"]
